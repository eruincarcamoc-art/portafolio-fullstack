// Micro-benchmark reproducible:  node scripts/bench.mjs   (requiere `npm run build`)
import { parse } from '../dist/index.js';

function bench(label, expr, opts, n) {
  const s = parse(expr, opts);
  s.nextRuns(100, new Date('2026-01-01T00:00:00Z')); // calentamiento
  const t = performance.now();
  const runs = s.nextRuns(n, new Date('2026-01-01T00:00:00Z'));
  const ms = performance.now() - t;
  console.log(`${label.padEnd(54)} ${String(runs.length).padStart(7)} runs  ${ms.toFixed(0).padStart(5)} ms  ${Math.round(runs.length / (ms / 1000)).toLocaleString('en-US').padStart(10)} runs/s`);
}

bench('UTC     */5 * * * *', '*/5 * * * *', {}, 100_000);
bench('UTC     0 9 * * 1-5 (sparse)', '0 9 * * 1-5', {}, 100_000);
bench('UTC     0 0 29 2 * (leap days)', '0 0 29 2 *', {}, 2);
bench('New_York */5 * * * * (Intl per run)', '*/5 * * * *', { tz: 'America/New_York' }, 20_000);
bench('New_York 30 2 * * * (DST-sensitive)', '30 2 * * *', { tz: 'America/New_York' }, 20_000);

const t = performance.now();
for (let i = 0; i < 20_000; i++) parse(`${i % 60} ${i % 24} * * 1-5`).expression;
console.log(`parse() 20 000 expressions: ${(performance.now() - t).toFixed(0)} ms`);
