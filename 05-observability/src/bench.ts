import { buildApi } from './api.js';
import { loadConfig } from './config.js';
import { Ingestor } from './ingest.js';
import { createRuntime } from './runtime.js';
import { runQuery } from './query.js';
import { Store } from './store.js';
import { SeriesRegistry } from './series.js';

/**
 * Benchmark reproducible (`npm run bench`). Mide con datos sintéticos, en esta máquina:
 *   1. ingesta en proceso (agregación + volcado a SQLite),
 *   2. ingesta de extremo a extremo por HTTP (JSON, parsing, validación),
 *   3. latencia de consultas sobre lo ingerido.
 * Los números dependen del hardware: sirven para comparar cambios, no como promesa.
 */
const N_POINTS = Number(process.env.BENCH_POINTS ?? 1_000_000);
const SERIES = Number(process.env.BENCH_SERIES ?? 500);
const BATCH = 1000;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

function makePoints(n: number, tBase: number, seriesCount: number) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({
      name: i % 5 === 0 ? 'bench_latency_ms' : 'bench_requests',
      type: (i % 5 === 0 ? 'timer' : 'counter') as 'timer' | 'counter',
      labels: { host: `h${i % seriesCount}`, route: `/r${i % 7}` },
      value: i % 5 === 0 ? 20 + ((i * 7919) % 480) : 1,
      ts: tBase + (i % 600) * 100, // 60 s de datos repartidos
    });
  }
  return pts;
}

// ---------- 1. en proceso ----------
{
  const cfg = loadConfig({ NODE_ENV: 'test', DB_PATH: ':memory:', MAX_SERIES_PER_METRIC: '100000', MAX_SERIES_TOTAL: '100000', MAX_PENDING_KEYS: '5000000' } as any);
  const store = new Store(':memory:', cfg);
  const registry = new SeriesRegistry(cfg.MAX_SERIES_PER_METRIC, cfg.MAX_SERIES_TOTAL);
  const ing = new Ingestor(store, registry, cfg);
  const t0 = Date.now() - 60_000;
  const pts = makePoints(N_POINTS, t0, SERIES);
  const start = performance.now();
  for (let i = 0; i < pts.length; i += BATCH) ing.ingest(pts.slice(i, i + BATCH));
  ing.flush();
  const s = (performance.now() - start) / 1000;
  console.log(`\n[1] in-process   ${fmt(N_POINTS)} points → ${fmt(N_POINTS / s)} points/s  (${s.toFixed(2)} s)`);
  console.log(`    ${fmt(N_POINTS)} points became ${fmt(store.counts().buckets_10s!)} stored rows (${(N_POINTS / store.counts().buckets_10s!).toFixed(0)}:1 compression)`);

  const timeIt = (label: string, fn: () => unknown, reps = 20) => {
    fn();
    const ts: number[] = [];
    for (let i = 0; i < reps; i++) { const a = performance.now(); fn(); ts.push(performance.now() - a); }
    ts.sort((a, b) => a - b);
    console.log(`    query ${label.padEnd(46)} p50 ${ts[Math.floor(reps / 2)]!.toFixed(1)} ms   max ${ts.at(-1)!.toFixed(1)} ms`);
  };
  const now = Date.now();
  const base = { from: now - 120_000, to: now + 10_000, stepSec: 10 };
  console.log('');
  timeIt('rate, group by route (500 hosts × 7 routes)', () => runQuery(store, registry, { ...base, metric: 'bench_requests', agg: 'rate', groupBy: ['route'] }, now));
  timeIt('p99, group by route (sketch merge)', () => runQuery(store, registry, { ...base, metric: 'bench_latency_ms', agg: 'p99', groupBy: ['route'] }, now));
  timeIt('avg, single series filtered by host', () => runQuery(store, registry, { ...base, metric: 'bench_requests', agg: 'avg', filters: { host: 'h42' } }, now));
  store.close();
}

// ---------- 2. HTTP de extremo a extremo ----------
{
  const cfg = loadConfig({ NODE_ENV: 'test', DB_PATH: ':memory:', MAX_SERIES_PER_METRIC: '100000', MAX_SERIES_TOTAL: '100000', MAX_PENDING_KEYS: '5000000' } as any);
  const rt = createRuntime(cfg);
  const app = await buildApi(rt);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const total = Math.min(N_POINTS, 300_000);
  const bodies: string[] = [];
  const pts = makePoints(total, Date.now() - 60_000, SERIES);
  for (let i = 0; i < pts.length; i += BATCH) bodies.push(JSON.stringify({ points: pts.slice(i, i + BATCH) }));
  const CONC = 8;
  let next = 0;
  let failures = 0;
  const lat: number[] = [];
  const start = performance.now();
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (next < bodies.length) {
        const body = bodies[next++]!;
        const t = performance.now();
        const res = await fetch(`http://127.0.0.1:${port}/v1/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        await res.arrayBuffer();
        lat.push(performance.now() - t);
        if (res.status !== 202) failures++;
      }
    }),
  );
  const s = (performance.now() - start) / 1000;
  lat.sort((a, b) => a - b);
  console.log(`\n[2] HTTP ingest  ${fmt(total)} points in ${bodies.length} requests of ${BATCH}, ${CONC} concurrent`);
  console.log(`    ${fmt(total / s)} points/s · ${fmt(bodies.length / s)} req/s · request latency p50 ${lat[Math.floor(lat.length / 2)]!.toFixed(1)} ms, p99 ${lat[Math.floor(lat.length * 0.99)]!.toFixed(1)} ms · non-202: ${failures}`);
  await app.close();
  await rt.stop();
}
console.log('');
