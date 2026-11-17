import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { checkBudget, costUsd, logUsage } from '../cost.js';
import { REFUSAL } from '../providers/local.js';
import type { ChatMessage, Embedder, Llm } from '../providers/types.js';
import { cacheLookup, cacheStore } from './cache.js';
import { buildPrompt, extractCitations } from './prompt.js';
import { retrieve, type RetrievedChunk, type RetrievalMode } from './retrieve.js';

export interface SourceView {
  n: number;
  documentId: number;
  title: string;
  section: string;
  excerpt: string;
  similarity: number | null;
}

export type AnswerEvent =
  | { type: 'sources'; sources: SourceView[] }
  | { type: 'token'; text: string }
  | { type: 'done'; result: AnswerResult };

export interface AnswerResult {
  answer: string;
  /** Números [n] citados que existen en el contexto. */
  citations: number[];
  /** Citas inventadas por el modelo (no existen en el contexto). */
  invalidCitations: number[];
  /** true si la respuesta se apoya en el contexto: tiene citas válidas o es un rechazo explícito. */
  grounded: boolean;
  refused: boolean;
  cached: boolean;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: { total: number; retrieval: number; firstToken: number | null };
  sources: SourceView[];
}

export interface AnswerDeps {
  db: Db;
  embedder: Embedder;
  llm: Llm;
  cfg: Config;
}

export interface AnswerOptions {
  clientId: string;
  history?: ChatMessage[];
  mode?: RetrievalMode;
  signal?: AbortSignal;
  /** Desactivar la caché (la evaluación necesita ejecutar el pipeline de verdad). */
  useCache?: boolean;
  /** Desactivar el presupuesto (evaluación interna). */
  enforceBudget?: boolean;
}

const view = (chunks: RetrievedChunk[]): SourceView[] =>
  chunks.map((c, i) => ({
    n: i + 1,
    documentId: c.documentId,
    title: c.title,
    section: c.heading,
    excerpt: c.content.length > 280 ? c.content.slice(0, 280) + '…' : c.content,
    similarity: c.similarity,
  }));

/**
 * Pipeline completo de una pregunta:
 *   presupuesto → caché semántica → recuperación híbrida → compuerta de confianza (rechazo sin gastar tokens)
 *   → LLM en streaming → validación de citas → contabilidad de uso/coste → caché.
 */
export async function answerQuestion(
  deps: AnswerDeps,
  question: string,
  opts: AnswerOptions,
  onEvent: (e: AnswerEvent) => void = () => {},
): Promise<AnswerResult> {
  const { db, embedder, llm, cfg } = deps;
  const started = Date.now();
  const prices = { inputPerMTok: cfg.PRICE_INPUT_PER_MTOK, outputPerMTok: cfg.PRICE_OUTPUT_PER_MTOK };
  const record = (outcome: Parameters<typeof logUsage>[1]['outcome'], inTok: number, outTok: number, cached: boolean) =>
    logUsage(db, {
      clientId: opts.clientId, kind: 'chat', model: llm.model, inputTokens: inTok, outputTokens: outTok,
      costUsd: costUsd(inTok, outTok, prices), latencyMs: Date.now() - started, cached, outcome,
    });

  if (opts.enforceBudget !== false) await checkBudget(db, opts.clientId, cfg.DAILY_TOKEN_BUDGET);

  const retrieval = await retrieve(db, embedder, question, { k: cfg.RETRIEVAL_K, mode: opts.mode }, opts.signal);
  const retrievalMs = Date.now() - started;
  const sources = view(retrieval.chunks);

  // ---- caché semántica (solo preguntas sin historial: con historial el contexto cambia el significado) ----
  const useCache = opts.useCache !== false && !(opts.history?.length);
  const queryEmbedding = retrieval.queryVector;
  if (useCache && queryEmbedding && retrieval.chunks.length) {
    const hit = await cacheLookup(db, queryEmbedding, cfg.CACHE_SIMILARITY, cfg.CACHE_TTL_HOURS);
    if (hit) {
      const cachedSources = hit.sources as SourceView[];
      onEvent({ type: 'sources', sources: cachedSources });
      onEvent({ type: 'token', text: hit.answer });
      const result: AnswerResult = {
        answer: hit.answer, citations: extractCitations(hit.answer), invalidCitations: [], grounded: true, refused: false,
        cached: true, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        latencyMs: { total: Date.now() - started, retrieval: retrievalMs, firstToken: Date.now() - started }, sources: cachedSources,
      };
      await record('cache_hit', 0, 0, true);
      onEvent({ type: 'done', result });
      return result;
    }
  }

  // ---- compuerta de confianza: rechazar ANTES de llamar al modelo si el contexto no sirve ----
  // (ahorra el coste de la llamada y evita respuestas alucinadas sobre contexto irrelevante)
  const confident = retrieval.chunks.length > 0 && (retrieval.topSimilarity >= cfg.MIN_SIMILARITY || retrieval.coverage >= cfg.MIN_COVERAGE);
  if (!confident) {
    onEvent({ type: 'sources', sources: [] });
    onEvent({ type: 'token', text: REFUSAL });
    const result: AnswerResult = {
      answer: REFUSAL, citations: [], invalidCitations: [], grounded: true, refused: true, cached: false,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latencyMs: { total: Date.now() - started, retrieval: retrievalMs, firstToken: null }, sources: [],
    };
    await record('refused', 0, 0, false);
    onEvent({ type: 'done', result });
    return result;
  }

  onEvent({ type: 'sources', sources });
  const prompt = buildPrompt(question, retrieval.chunks, opts.history);
  let answer = '';
  let inTok = 0;
  let outTok = 0;
  let firstToken: number | null = null;
  try {
    for await (const ev of llm.stream({ system: prompt.system, messages: prompt.messages, maxTokens: cfg.MAX_ANSWER_TOKENS, signal: opts.signal })) {
      if (ev.type === 'text') {
        firstToken ??= Date.now() - started;
        answer += ev.text;
        onEvent({ type: 'token', text: ev.text });
      } else {
        inTok = ev.inputTokens;
        outTok = ev.outputTokens;
      }
    }
  } catch (err) {
    // Se factura lo ya generado aunque el stream se corte (cliente cerrado o proveedor caído).
    await record(opts.signal?.aborted ? 'aborted' : 'error', inTok, outTok || Math.ceil(answer.length / 4), false);
    throw err;
  }
  if (opts.signal?.aborted) {
    await record('aborted', inTok, outTok || Math.ceil(answer.length / 4), false);
    throw opts.signal.reason ?? new Error('aborted');
  }

  // ---- validación de la respuesta ----
  const refused = answer.trim().startsWith("I don't have enough information");
  const cited = extractCitations(answer);
  const valid = cited.filter((n) => prompt.citations.has(n));
  const invalid = cited.filter((n) => !prompt.citations.has(n));
  const grounded = refused || (valid.length > 0 && invalid.length === 0);

  const result: AnswerResult = {
    answer, citations: valid, invalidCitations: invalid, grounded, refused, cached: false,
    usage: { inputTokens: inTok, outputTokens: outTok, costUsd: costUsd(inTok, outTok, prices) },
    latencyMs: { total: Date.now() - started, retrieval: retrievalMs, firstToken },
    sources,
  };
  await record(refused ? 'refused' : 'ok', inTok, outTok, false);
  if (grounded && !refused && useCache && queryEmbedding) {
    await cacheStore(db, question, queryEmbedding, answer, sources).catch(() => {});
  }
  onEvent({ type: 'done', result });
  return result;
}
