import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { createEmbedder, createLlm } from '../providers/index.js';
import { checkGate, type Thresholds } from './metrics.js';
import { freshIndexedDb, runEval, type GoldenCase } from './run.js';
import type { RetrievalMode } from '../rag/retrieve.js';

/**
 * Uso:
 *   npm run eval                 informe completo + comparación de modos de recuperación
 *   npm run eval:gate            además compara con eval/thresholds.json y sale con código 1 si hay regresión
 *   npm run eval -- --verbose    detalle de cada pregunta fallida
 */
const gate = process.argv.includes('--gate');
const verbose = process.argv.includes('--verbose');

const cfg = loadConfig();
const embedder = createEmbedder(cfg);
const llm = createLlm(cfg);
const golden: GoldenCase[] = JSON.parse(await readFile('eval/golden.json', 'utf8'));
const db = await freshIndexedDb(embedder, 'corpus');

console.log(`\nEvaluating ${golden.length} questions · embedder=${embedder.name} · llm=${llm.name}\n`);

const modes: RetrievalMode[] = ['lexical', 'vector', 'hybrid'];
const results: Record<string, Awaited<ReturnType<typeof runEval>>> = {};
for (const m of modes) results[m] = await runEval({ db, embedder, llm, cfg }, golden, m);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`.padStart(6);
console.log('Retrieval by mode (answerable questions)');
console.log('mode      hit@1   hit@3   hit@5    MRR   hit@5 paraphrase');
for (const m of modes) {
  const r = results[m]!.summary.retrieval;
  console.log(`${m.padEnd(9)} ${pct(r.hit1)} ${pct(r.hit3)} ${pct(r.hit5)}  ${r.mrr.toFixed(3)}  ${pct(r.hit5Paraphrase)}`);
}

const h = results.hybrid!;
console.log('\nHybrid pipeline (what ships)');
console.log(`  correct answers     ${pct(h.summary.generation.correctRate)}   (all expected facts present, not refused)`);
console.log(`  facts recall        ${pct(h.summary.generation.factsRecall)}`);
console.log(`  grounded            ${pct(h.summary.generation.groundedRate)}   (valid citations or explicit refusal)`);
console.log(`  citation precision  ${pct(h.summary.generation.citationPrecision)}   (cited doc is the expected one)`);
console.log(`  unanswerable → refused  ${pct(h.summary.refusal.unanswerableRefused)}`);
console.log(`  answerable wrongly refused ${pct(h.summary.refusal.answerableRefusedWrongly)}`);
console.log(`  latency p50 / p95   ${h.summary.latency.p50} ms / ${h.summary.latency.p95} ms`);

const failed = h.cases.filter((c) => (c.answerable && (c.factsRecall < 1 || c.refused)) || (!c.answerable && !c.refused));
if (failed.length) {
  console.log(`\n${failed.length} failing case(s)${verbose ? '' : ' (use --verbose for details)'}:`);
  for (const c of failed) {
    console.log(`  ✗ ${c.id} [${c.kind}] ${c.question}`);
    if (verbose) console.log(`      retrieved: ${c.retrievedDocs.join(', ')}\n      answer: ${c.answer.slice(0, 160)}`);
  }
}

// ---- Calibración de la compuerta de confianza: ¿qué umbral separa mejor lo respondible de lo que no? ----
console.log('\nConfidence-gate sweep (refuse when similarity < S AND coverage < C; shown: unanswerable caught / answerable lost)');
const un = h.cases.filter((c) => !c.answerable);
const an = h.cases.filter((c) => c.answerable);
const refusedBy = (c: (typeof h.cases)[number], s: number, cov: number) => c.signals.topSimilarity < s && c.signals.coverage < cov;
for (const cov of [0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) {
  const caught = un.filter((c) => refusedBy(c, cfg.MIN_SIMILARITY, cov)).length;
  const lost = an.filter((c) => refusedBy(c, cfg.MIN_SIMILARITY, cov)).length;
  console.log(`  coverage<${cov.toFixed(2)}  caught ${caught}/${un.length}   lost ${lost}/${an.length}${Math.abs(cov - cfg.MIN_COVERAGE) < 1e-9 ? '   ← configured' : ''}`);
}
if (verbose) for (const c of [...un, ...an].sort((a, b) => a.signals.coverage - b.signals.coverage).slice(0, 12)) console.log(`    ${c.answerable ? 'ans' : 'UNA'} sim=${c.signals.topSimilarity.toFixed(2)} cov=${c.signals.coverage.toFixed(2)}  ${c.question}`);

await writeFile('eval/last-run.json', JSON.stringify({ at: new Date().toISOString(), embedder: embedder.name, llm: llm.name, modes: Object.fromEntries(modes.map((m) => [m, results[m]!.summary])) }, null, 2));

if (gate) {
  const thresholds: Thresholds = JSON.parse(await readFile('eval/thresholds.json', 'utf8'));
  const fails = checkGate(h.summary, thresholds);
  if (fails.length) {
    console.error('\n✗ QUALITY GATE FAILED');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\n✓ Quality gate passed');
}
await db.close();
