import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runQuery } from '../src/query.js';
import { Ingestor } from '../src/ingest.js';
import { SeriesRegistry } from '../src/series.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { T0, exactQuantile, makeSystem, normal, rng } from './helpers.js';

const sumQuery = (s: ReturnType<typeof makeSystem>, metric: string, from: number, to: number, stepSec: number, agg = 'sum') =>
  runQuery(s.store, s.registry, { metric, agg, from, to, stepSec }, s.clock.now());

describe('rollups', () => {
  it('1m and 1h tiers agree with the raw 10s tier (same totals at every resolution)', () => {
    const s = makeSystem();
    for (let sec = 0; sec < 3 * 3600; sec += 5) { s.clock.set(T0 + sec * 1000); s.ingestor.ingest([{ name: 'reqs', type: 'counter', value: 2, ts: T0 + sec * 1000 }]); }
    s.ingestor.flush();
    s.clock.set(T0 + 3 * 3600_000);
    s.store.rollup(s.clock.now());
    expect(s.store.counts().buckets_1m).toBe(180);
    expect(s.store.counts().buckets_1h).toBeGreaterThanOrEqual(3);

    const fine = sumQuery(s, 'reqs', T0, T0 + 3600_000, 60); // 10s o 1m
    const hour = sumQuery(s, 'reqs', T0, T0 + 3 * 3600_000, 3600);
    expect(fine.series[0]!.points.reduce((a, p) => a + p[1], 0)).toBe(1440); // 3600 s / 5 s * valor 2
    expect(hour.series[0]!.points.reduce((a, p) => a + p[1], 0)).toBe(4320);
    expect(hour.tier).toBe('1h');
  });

  it('percentiles survive two levels of rollup (sketches are merged, not averaged)', () => {
    const s = makeSystem();
    const r = rng(5);
    const all: number[] = [];
    for (let sec = 0; sec < 600; sec++) {
      const batch = Array.from({ length: 20 }, () => Math.exp(4 + normal(r)));
      all.push(...batch);
      s.ingestor.ingest(batch.map((v) => ({ name: 'lat', type: 'timer' as const, value: v, ts: T0 + sec * 1000 })));
    }
    s.ingestor.flush();
    s.clock.set(T0 + 3600_000);
    s.store.rollup(s.clock.now());
    for (const [step, tier] of [[10, '10s'], [60, '1m'], [3600, '1h']] as const) {
      const res = sumQuery(s, 'lat', T0, T0 + 3600_000, step, 'p99');
      expect(res.tier).toBe(tier);
      const merged = runQuery(s.store, s.registry, { metric: 'lat', agg: 'p99', from: T0, to: T0 + 3600_000, stepSec: 3600 }, s.clock.now()).series[0]!.points[0]![1];
      const exact = exactQuantile(all, 0.99);
      expect(Math.abs(merged - exact) / exact).toBeLessThan(0.012);
    }
  });

  it('late data corrects the aggregated tiers (idempotent recompute from the source)', () => {
    const s = makeSystem();
    s.ingestor.ingest([{ name: 'c', type: 'counter', value: 10, ts: T0 }]);
    s.ingestor.flush();
    s.clock.advance(10 * 60_000);
    s.store.rollup(s.clock.now());
    const before = sumQuery(s, 'c', T0, T0 + 60_000, 60).series[0]!.points[0]![1];
    expect(before).toBe(10);

    s.ingestor.ingest([{ name: 'c', type: 'counter', value: 5, ts: T0 + 20_000 }]); // llega 10 min tarde
    s.ingestor.flush();
    expect(s.store.counts().dirty).toBeGreaterThan(0);
    s.store.rollup(s.clock.now());
    expect(sumQuery(s, 'c', T0, T0 + 60_000, 60).series[0]!.points[0]![1]).toBe(15);
    expect(s.store.counts().dirty).toBe(0);
    s.store.rollup(s.clock.now()); // repetir no cambia nada
    expect(sumQuery(s, 'c', T0, T0 + 60_000, 60).series[0]!.points[0]![1]).toBe(15);
  });

  it('queries always see fresh data: dirty buckets are refreshed before reading a coarser tier', () => {
    const s = makeSystem();
    s.ingestor.ingest([{ name: 'c', type: 'counter', value: 7 }]);
    s.ingestor.flush();
    // sin ejecutar rollup a mano: la consulta de 1 min debe verlo igualmente
    expect(sumQuery(s, 'c', T0, T0 + 60_000, 60).series[0]!.points[0]![1]).toBe(7);
  });
});

describe('retention', () => {
  it('drops fine data first; coarse tiers keep covering older ranges', () => {
    const s = makeSystem();
    for (let m = 0; m < 30; m++) { s.clock.set(T0 + m * 60_000); s.ingestor.ingest([{ name: 'c', type: 'counter', value: 1, ts: T0 + m * 60_000 }]); }
    s.ingestor.flush();
    s.store.rollup(s.clock.now());
    const rows10 = s.store.counts().buckets_10s;

    s.clock.set(T0 + 8 * 3600_000); // 8 h después: el nivel de 10 s (6 h) ya expiró
    const r = s.store.applyRetention(s.clock.now());
    expect(r.deleted['10s']).toBe(rows10);
    expect(s.store.counts().buckets_10s).toBe(0);
    expect(s.store.counts().buckets_1m).toBe(30);

    const res = sumQuery(s, 'c', T0 - 60_000, T0 + 30 * 60_000, 60);
    expect(res.tier).toBe('1m'); // el planificador cae al nivel que aún tiene datos
    expect(res.series[0]!.points).toHaveLength(30);
  });

  it('late data for a bucket whose source already expired does NOT erase the aggregate', () => {
    const s = makeSystem();
    s.ingestor.ingest([{ name: 'c', type: 'counter', value: 10, ts: T0 }]);
    s.ingestor.flush();
    s.store.rollup(s.clock.now());
    s.clock.set(T0 + 8 * 3600_000);
    s.store.applyRetention(s.clock.now()); // el 10 s se borra, el 1 min se conserva
    s.store.db.prepare(`INSERT OR IGNORE INTO dirty(tier, ts) VALUES ('1m', ?)`).run(T0); // algo lo marca sucio
    s.store.rollup(s.clock.now()); // intenta recalcular desde una fuente vacía...
    expect(sumQuery(s, 'c', T0 - 60_000, T0 + 120_000, 60).series[0]!.points[0]![1]).toBe(10); // ...pero no destruye el dato
  });

  it('removes series that stopped reporting longer than the longest retention', () => {
    const s = makeSystem();
    s.ingestor.ingest([{ name: 'old', value: 1 }]);
    s.ingestor.flush();
    s.clock.set(T0 + 401 * 86_400_000);
    const r = s.store.applyRetention(s.clock.now());
    expect(r.seriesRemoved).toHaveLength(1);
    s.registry.forget(r.seriesRemoved[0]!);
    expect(s.registry.size).toBe(0);
  });
});

describe('durability', () => {
  it('data and series survive a restart (file-backed WAL database)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pulse-'));
    try {
      const cfg = loadConfig({ NODE_ENV: 'test' } as any);
      const file = path.join(dir, 'pulse.db');
      const open = () => {
        const store = new Store(file, cfg);
        const registry = new SeriesRegistry(cfg.MAX_SERIES_PER_METRIC, cfg.MAX_SERIES_TOTAL);
        registry.load(store.loadSeries());
        return { store, registry, ingestor: new Ingestor(store, registry, cfg, () => T0 + 5000) };
      };
      const a = open();
      a.ingestor.ingest([{ name: 'cpu', labels: { host: 'a' }, value: 42, ts: T0 }, { name: 'cpu', labels: { host: 'b' }, value: 10, ts: T0 }]);
      a.ingestor.close(); // el apagado ordenado vuelca lo pendiente
      a.store.close();

      const b = open();
      expect(b.registry.size).toBe(2);
      const res = runQuery(b.store, b.registry, { metric: 'cpu', agg: 'max', from: T0, to: T0 + 60_000, stepSec: 10, groupBy: ['host'] }, T0 + 5000);
      expect(res.series.map((x) => [x.labels.host, x.points[0]![1]])).toEqual([['a', 42], ['b', 10]]);
      // y una serie nueva recibe un id que no colisiona
      b.ingestor.ingest([{ name: 'cpu', labels: { host: 'c' }, value: 1, ts: T0 }]);
      b.ingestor.flush();
      expect(b.registry.size).toBe(3);
      b.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
