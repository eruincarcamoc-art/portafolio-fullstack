import { contentTerms, splitSentences } from './text.js';
import { estimateTokens, type Embedder, type Llm, type LlmEvent, type LlmRequest } from './types.js';

/**
 * Embeddings locales deterministas ("hashing trick"): sin red, sin claves, mismos resultados siempre.
 *
 * Es el sustituto de desarrollo, NO un modelo semántico: captura solapamiento léxico (palabras, bigramas
 * y trigramas de caracteres, con stemming), no sinónimos. Para calidad real se usa Voyage u otro modelo.
 * Su valor aquí es que permite ejecutar y probar TODO el pipeline (y la evaluación) sin dependencias externas.
 */
export class LocalEmbedder implements Embedder {
  readonly name = 'local-hash';
  constructor(readonly dims = 256) {}

  async embed(texts: string[], _kind?: 'document' | 'query', _signal?: AbortSignal) {
    return { vectors: texts.map((t) => this.vec(t)), tokens: texts.reduce((n, t) => n + estimateTokens(t), 0) };
  }

  private vec(text: string): number[] {
    const v = new Float64Array(this.dims);
    const terms = contentTerms(text);
    const tf = new Map<string, number>();
    const add = (feat: string, w: number) => tf.set(feat, (tf.get(feat) ?? 0) + w);
    terms.forEach((t, i) => {
      add('w:' + t, 1);
      if (i > 0) add('b:' + terms[i - 1] + '_' + t, 0.6);
      const padded = `^${t}$`;
      for (let j = 0; j + 3 <= padded.length; j++) add('c:' + padded.slice(j, j + 3), 0.25);
    });
    for (const [feat, w] of tf) {
      const h = fnv1a(feat);
      const sign = (h & 1) === 0 ? 1 : -1;
      v[(h >>> 1) % this.dims]! += sign * (w > 1 ? 1 + Math.log(w) : w); // tf sublineal
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return Array.from(v, (x) => x / norm);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const REFUSAL = "I don't have enough information in the provided documents to answer that.";

/**
 * LLM local "extractivo": no genera, SELECCIONA. Lee los bloques <document id="n"> del prompt, puntúa las
 * frases por solapamiento con la pregunta (ponderado por rareza) y responde citando [n].
 * Cumple el mismo contrato que un LLM real (streaming, uso de tokens, rechazo cuando no hay base),
 * así el resto del sistema se desarrolla y se evalúa sin gastar tokens.
 */
export class LocalLlm implements Llm {
  readonly name = 'local-extractive';
  readonly model = 'local-extractive';

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const prompt = req.messages.at(-1)?.content ?? '';
    const answer = this.answer(prompt);
    const words = answer.split(/(\s+)/).filter(Boolean);
    for (const w of words) {
      if (req.signal?.aborted) return;
      yield { type: 'text', text: w };
      if (/\s/.test(w)) await new Promise((r) => setTimeout(r, 4)); // ritmo de streaming perceptible
    }
    yield { type: 'usage', inputTokens: estimateTokens(req.system + prompt), outputTokens: estimateTokens(answer) };
  }

  private answer(prompt: string): string {
    const question = /<question>([\s\S]*?)<\/question>/.exec(prompt)?.[1]?.trim() ?? '';
    const qTerms = [...new Set(contentTerms(question))];
    if (!qTerms.length) return REFUSAL;

    const docs = [...prompt.matchAll(/<document id="(\d+)"[^>]*>([\s\S]*?)<\/document>/g)].map((m) => ({
      id: m[1]!,
      sentences: splitSentences(unescapeXml(m[2]!)),
    }));
    const all = docs.flatMap((d) => d.sentences.map((s) => ({ id: d.id, text: s, terms: new Set(contentTerms(s)) })));
    if (!all.length) return REFUSAL;

    // rareza: términos que aparecen en pocas frases pesan más
    const df = new Map<string, number>();
    for (const s of all) for (const t of s.terms) df.set(t, (df.get(t) ?? 0) + 1);
    const idf = (t: string) => Math.log(1 + all.length / (df.get(t) ?? 0.5));

    const scored = all
      .map((s) => {
        const hits = qTerms.filter((t) => s.terms.has(t));
        return { ...s, hits: hits.length, score: hits.reduce((n, t) => n + idf(t), 0) };
      })
      .filter((s) => s.hits >= Math.min(2, qTerms.length))
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return REFUSAL;

    const best = scored[0]!;
    const picked = [best, ...scored.slice(1).filter((s) => s.id === best.id && s.score >= best.score * 0.6)].slice(0, 2);
    return picked.map((s) => `${s.text} [${s.id}]`).join(' ');
  }
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
