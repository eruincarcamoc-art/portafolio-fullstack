import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { createPgliteDb, migrate, type Db } from '../db.js';
import { answerQuestion } from '../rag/answer.js';
import { ingestDocument } from '../rag/ingest.js';
import { retrieve, type RetrievalMode } from '../rag/retrieve.js';
import type { Embedder, Llm } from '../providers/types.js';
import { type CaseResult, factsRecall, reciprocalRank, hitAtK, summarize, type Summary } from './metrics.js';

export interface GoldenCase {
  id: string;
  kind: 'direct' | 'paraphrase' | 'unanswerable';
  question: string;
  answerable: boolean;
  docs: string[];
  facts: string[][];
}

export async function loadCorpus(dir: string) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  return Promise.all(
    files.map(async (f) => ({
      source: f,
      title: titleOf(await readFile(path.join(dir, f), 'utf8'), f),
      content: await readFile(path.join(dir, f), 'utf8'),
    })),
  );
}

const titleOf = (md: string, fallback: string) => /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? fallback;

export async function indexCorpus(db: Db, embedder: Embedder, dir: string) {
  for (const d of await loadCorpus(dir)) await ingestDocument(db, embedder, d);
}

export interface EvalDeps {
  db: Db;
  embedder: Embedder;
  llm: Llm;
  cfg: Config;
}

/** Ejecuta el dataset dorado a través del pipeline REAL (sin caché ni presupuesto) y mide cada etapa. */
export async function runEval(deps: EvalDeps, golden: GoldenCase[], mode: RetrievalMode = 'hybrid'): Promise<{ summary: Summary; cases: CaseResult[] }> {
  const docOf = new Map<number, string>(
    (await deps.db.tx((q) => q.query<{ id: number; source: string }>(`SELECT id::int, source FROM documents`))).map((d) => [d.id, d.source]),
  );
  const cases: CaseResult[] = [];
  for (const g of golden) {
    const t0 = Date.now();
    const ret = await retrieve(deps.db, deps.embedder, g.question, { k: deps.cfg.RETRIEVAL_K, mode });
    const retrievedDocs = ret.chunks.map((c) => docOf.get(c.documentId) ?? '?');
    const res = await answerQuestion(deps, g.question, { clientId: 'eval', mode, useCache: false, enforceBudget: false });
    const citedDocs = res.citations.map((n) => res.sources[n - 1]?.documentId).filter((x): x is number => x !== undefined).map((id) => docOf.get(id) ?? '?');
    cases.push({
      id: g.id, kind: g.kind, answerable: g.answerable, question: g.question,
      retrievedDocs,
      hit1: hitAtK(retrievedDocs, g.docs, 1), hit3: hitAtK(retrievedDocs, g.docs, 3), hit5: hitAtK(retrievedDocs, g.docs, 5),
      rr: reciprocalRank(retrievedDocs, g.docs),
      answer: res.answer, factsRecall: g.answerable ? factsRecall(res.answer, g.facts) : 1,
      refused: res.refused, grounded: res.grounded, citationsValid: res.invalidCitations.length === 0,
      citationPrecision: g.answerable && citedDocs.length ? citedDocs.filter((d) => g.docs.includes(d)).length / citedDocs.length : null,
      latencyMs: Date.now() - t0,
      signals: { topSimilarity: ret.topSimilarity, coverage: ret.coverage },
    });
  }
  return { summary: summarize(cases), cases };
}

export async function freshIndexedDb(embedder: Embedder, corpusDir: string): Promise<Db> {
  const db = createPgliteDb();
  await migrate(db, embedder.dims);
  await indexCorpus(db, embedder, corpusDir);
  return db;
}
