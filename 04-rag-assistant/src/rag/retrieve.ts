import { toVector, type Db } from '../db.js';
import type { Embedder } from '../providers/types.js';
import { contentTerms } from '../providers/text.js';

export type RetrievalMode = 'hybrid' | 'vector' | 'lexical';

export interface RetrievedChunk {
  id: number;
  documentId: number;
  title: string;
  source: string;
  heading: string;
  content: string;
  /** Puntuación final de ordenación (RRF en híbrido). */
  score: number;
  /** Similitud coseno con la consulta (0-1), o null si el chunk solo vino de la búsqueda léxica. */
  similarity: number | null;
  vectorRank: number | null;
  lexicalRank: number | null;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** Señales de confianza para decidir si responder o rechazar. */
  topSimilarity: number;
  coverage: number;
  queryTokens: number;
  /** Embedding de la consulta (null en modo léxico): se reutiliza para la caché semántica. */
  queryVector: number[] | null;
  timings: { embedMs: number; searchMs: number };
}

export interface RetrieveOptions {
  k?: number;
  /** Candidatos que aporta cada método antes de fusionar. */
  candidates?: number;
  mode?: RetrievalMode;
  /** Máximo de chunks del mismo documento: evita que un documento monopolice el contexto. */
  maxPerDoc?: number;
  rrfK?: number;
}

const COLS = `c.id::int AS id, c.document_id::int AS "documentId", d.title, d.source, c.heading, c.content`;

/** tsquery OR de los términos de la pregunta: las preguntas naturales no deben exigir TODAS las palabras. */
export function lexicalQuery(question: string): string | null {
  const terms = [...new Set(contentTerms(question))].filter((t) => /^[a-z0-9]+$/.test(t));
  return terms.length ? terms.map((t) => `${t}:*`).join(' | ') : null;
}

/**
 * Búsqueda híbrida:
 *  - vectorial (pgvector, coseno): entiende paráfrasis y sinónimos, pero falla con códigos, nombres y cifras exactas;
 *  - léxica (tsvector + ts_rank_cd): exacta con términos raros, pero ciega a los sinónimos;
 *  - se fusionan con Reciprocal Rank Fusion (RRF): suma 1/(k+rank), sin tener que normalizar puntuaciones
 *    de escalas incomparables.
 */
export async function retrieve(db: Db, embedder: Embedder, question: string, opts: RetrieveOptions = {}, signal?: AbortSignal): Promise<RetrievalResult> {
  const k = opts.k ?? 5;
  const candidates = opts.candidates ?? 20;
  const mode = opts.mode ?? 'hybrid';
  const maxPerDoc = opts.maxPerDoc ?? 3;
  const rrfK = opts.rrfK ?? 60;

  const t0 = Date.now();
  const useVector = mode !== 'lexical';
  const qEmb = useVector ? await embedder.embed([question], 'query', signal) : { vectors: [[]], tokens: 0 };
  const embedMs = Date.now() - t0;

  const t1 = Date.now();
  const tsq = lexicalQuery(question);
  const { vec, lex } = await db.tx(async (q) => {
    const vec = useVector
      ? await q.query<any>(
          `SELECT ${COLS}, 1 - (c.embedding <=> $1::vector) AS similarity
             FROM chunks c JOIN documents d ON d.id = c.document_id
            ORDER BY c.embedding <=> $1::vector LIMIT $2`,
          [toVector(qEmb.vectors[0]!), candidates],
        )
      : [];
    const lex =
      mode !== 'vector' && tsq
        ? await q.query<any>(
            `SELECT ${COLS}, ts_rank_cd(c.tsv, to_tsquery('simple', $1)) AS rank
               FROM chunks c JOIN documents d ON d.id = c.document_id
              WHERE c.tsv @@ to_tsquery('simple', $1)
              ORDER BY rank DESC, c.id LIMIT $2`,
            [tsq, candidates],
          )
        : [];
    return { vec, lex };
  });
  const searchMs = Date.now() - t1;

  const byId = new Map<number, RetrievedChunk>();
  const upsert = (r: any): RetrievedChunk => {
    let c = byId.get(r.id);
    if (!c) {
      c = { id: r.id, documentId: r.documentId, title: r.title, source: r.source, heading: r.heading, content: r.content, score: 0, similarity: null, vectorRank: null, lexicalRank: null };
      byId.set(r.id, c);
    }
    return c;
  };
  vec.forEach((r: any, i: number) => {
    const c = upsert(r);
    c.vectorRank = i + 1;
    c.similarity = Number(r.similarity);
    c.score += 1 / (rrfK + i + 1);
  });
  lex.forEach((r: any, i: number) => {
    const c = upsert(r);
    c.lexicalRank = i + 1;
    c.score += 1 / (rrfK + i + 1);
  });

  const ranked = [...byId.values()].sort((a, b) => b.score - a.score || a.id - b.id);
  const perDoc = new Map<number, number>();
  const chunks: RetrievedChunk[] = [];
  for (const c of ranked) {
    const n = perDoc.get(c.documentId) ?? 0;
    if (n >= maxPerDoc) continue;
    perDoc.set(c.documentId, n + 1);
    chunks.push(c);
    if (chunks.length >= k) break;
  }

  // Señales de confianza: ¿hay algo realmente parecido y cubre las palabras de la pregunta?
  const topSimilarity = vec.length ? Number(vec[0].similarity) : 0;
  const coverage = await idfCoverage(db, question, chunks[0]);

  return { chunks, topSimilarity, coverage, queryTokens: qEmb.tokens, queryVector: useVector ? qEmb.vectors[0]! : null, timings: { embedMs, searchMs } };
}

/**
 * Cobertura ponderada por rareza (IDF): qué fracción del "peso informativo" de la pregunta aparece en el mejor chunk.
 * Una palabra que no existe en NINGÚN documento ("student", "Madrid") pesa al máximo y queda sin cubrir, así que
 * delata una pregunta fuera del corpus; una marca presente en todos los documentos ("Northwind") apenas pesa.
 */
async function idfCoverage(db: Db, question: string, top: RetrievedChunk | undefined): Promise<number> {
  const terms = [...new Set(contentTerms(question))].filter((t) => /^[a-z0-9]+$/.test(t));
  if (!terms.length || !top) return 0;
  const { n, df } = await db.tx(async (q) => {
    const n = Number((await q.query<{ c: string }>(`SELECT count(*) AS c FROM chunks`))[0]!.c);
    const rows = await q.query<{ t: string; df: string }>(
      `SELECT t, (SELECT count(*) FROM chunks WHERE tsv @@ to_tsquery('simple', t || ':*')) AS df FROM unnest($1::text[]) AS t`,
      [terms],
    );
    return { n, df: new Map(rows.map((r) => [r.t, Number(r.df)])) };
  });
  const topTerms = new Set(contentTerms(`${top.title} ${top.heading} ${top.content}`));
  let total = 0;
  let covered = 0;
  for (const t of terms) {
    const w = Math.log(1 + n / ((df.get(t) ?? 0) + 0.5));
    total += w;
    if (topTerms.has(t)) covered += w;
  }
  return total ? covered / total : 0;
}
