/** Métricas puras de evaluación (sin I/O): fáciles de testear y de razonar. */

/** 1 si algún documento esperado aparece entre los k primeros resultados. */
export function hitAtK(retrievedDocs: string[], expected: string[], k: number): number {
  return retrievedDocs.slice(0, k).some((d) => expected.includes(d)) ? 1 : 0;
}

/** Reciprocal rank del primer resultado relevante (0 si no aparece). */
export function reciprocalRank(retrievedDocs: string[], expected: string[]): number {
  const i = retrievedDocs.findIndex((d) => expected.includes(d));
  return i < 0 ? 0 : 1 / (i + 1);
}

/** Cada grupo de hechos es una lista de alternativas aceptables; hace falta acertar UNA por grupo. */
export function factsRecall(answer: string, facts: string[][]): number {
  if (!facts.length) return 1;
  const a = answer.toLowerCase();
  return facts.filter((alts) => alts.some((f) => a.includes(f.toLowerCase()))).length / facts.length;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface CaseResult {
  id: string;
  kind: 'direct' | 'paraphrase' | 'unanswerable';
  answerable: boolean;
  question: string;
  retrievedDocs: string[];
  hit1: number;
  hit3: number;
  hit5: number;
  rr: number;
  answer: string;
  factsRecall: number;
  refused: boolean;
  grounded: boolean;
  citationsValid: boolean;
  /** ¿Las citas apuntan a un documento esperado? */
  citationPrecision: number | null;
  latencyMs: number;
  /** Señales de la compuerta de confianza (para calibrar umbrales). */
  signals: { topSimilarity: number; coverage: number };
}

export interface Summary {
  cases: number;
  retrieval: { hit1: number; hit3: number; hit5: number; mrr: number; hit5Paraphrase: number; hit5Direct: number };
  generation: { factsRecall: number; correctRate: number; groundedRate: number; citationPrecision: number };
  refusal: { unanswerableRefused: number; answerableRefusedWrongly: number };
  latency: { p50: number; p95: number };
}

export function summarize(rs: CaseResult[]): Summary {
  const ans = rs.filter((r) => r.answerable);
  const un = rs.filter((r) => !r.answerable);
  const cp = ans.map((r) => r.citationPrecision).filter((x): x is number => x !== null);
  const sub = (kind: string) => ans.filter((r) => r.kind === kind);
  const r2 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    cases: rs.length,
    retrieval: {
      hit1: r2(mean(ans.map((r) => r.hit1))),
      hit3: r2(mean(ans.map((r) => r.hit3))),
      hit5: r2(mean(ans.map((r) => r.hit5))),
      mrr: r2(mean(ans.map((r) => r.rr))),
      hit5Paraphrase: r2(mean(sub('paraphrase').map((r) => r.hit5))),
      hit5Direct: r2(mean(sub('direct').map((r) => r.hit5))),
    },
    generation: {
      factsRecall: r2(mean(ans.map((r) => r.factsRecall))),
      correctRate: r2(mean(ans.map((r) => (r.factsRecall === 1 && !r.refused ? 1 : 0)))),
      groundedRate: r2(mean(rs.map((r) => (r.grounded ? 1 : 0)))),
      citationPrecision: r2(mean(cp)),
    },
    refusal: {
      unanswerableRefused: r2(un.length ? mean(un.map((r) => (r.refused ? 1 : 0))) : 1),
      answerableRefusedWrongly: r2(mean(ans.map((r) => (r.refused ? 1 : 0)))),
    },
    latency: { p50: Math.round(percentile(rs.map((r) => r.latencyMs), 50)), p95: Math.round(percentile(rs.map((r) => r.latencyMs), 95)) },
  };
}

export interface Thresholds {
  retrieval: { hit5: number; mrr: number };
  generation: { correctRate: number; groundedRate: number; citationPrecision: number };
  refusal: { unanswerableRefused: number; answerableRefusedWrongly: number };
}

/** Compara con los umbrales; devuelve las violaciones (vacío = pasa). */
export function checkGate(s: Summary, t: Thresholds): string[] {
  const fails: string[] = [];
  const min = (name: string, v: number, th: number) => v < th && fails.push(`${name}: ${v} < ${th}`);
  const max = (name: string, v: number, th: number) => v > th && fails.push(`${name}: ${v} > ${th}`);
  min('retrieval.hit5', s.retrieval.hit5, t.retrieval.hit5);
  min('retrieval.mrr', s.retrieval.mrr, t.retrieval.mrr);
  min('generation.correctRate', s.generation.correctRate, t.generation.correctRate);
  min('generation.groundedRate', s.generation.groundedRate, t.generation.groundedRate);
  min('generation.citationPrecision', s.generation.citationPrecision, t.generation.citationPrecision);
  min('refusal.unanswerableRefused', s.refusal.unanswerableRefused, t.refusal.unanswerableRefused);
  max('refusal.answerableRefusedWrongly', s.refusal.answerableRefusedWrongly, t.refusal.answerableRefusedWrongly);
  return fails;
}
