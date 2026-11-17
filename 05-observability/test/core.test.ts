import { describe, it, expect } from 'vitest';
import { Sketch } from '../src/sketch.js';
import { addValue, computeAgg, mergeCell, newCell } from '../src/cell.js';
import { CardinalityError, SeriesRegistry, seriesKey, TypeConflictError, validateLabels, validateName, ValidationError } from '../src/series.js';
import { Overloaded } from '../src/ingest.js';
import { pickTier, runQuery, QueryError, instantQuery } from '../src/query.js';
import { tiersOf } from '../src/store.js';
import { T0, exactQuantile, makeSystem, normal, rng } from './helpers.js';

describe('Sketch (percentiles con error relativo acotado)', () => {
  it('stays within 1% relative error on heavy-tailed latency data', () => {
    const r = rng(7);
    const data = Array.from({ length: 50_000 }, () => Math.exp(4 + 1.2 * normal(r))); // lognormal: cola larga, como las latencias reales
    const sk = new Sketch();
    for (const x of data) sk.add(x);
    for (const q of [0.5, 0.9, 0.95, 0.99, 0.999]) {
      const exact = exactQuantile(data, q);
      expect(Math.abs(sk.quantile(q)! - exact) / exact).toBeLessThan(0.011);
    }
    expect(sk.bucketCount).toBeLessThan(1500); // memoria acotada aunque haya 50 000 valores
  });

  it('is mergeable: merging two sketches equals the sketch of the union (the property that makes rollups correct)', () => {
    const r = rng(11);
    const a = Array.from({ length: 5000 }, () => Math.exp(3 + normal(r)));
    const b = Array.from({ length: 5000 }, () => Math.exp(5 + 0.5 * normal(r)));
    const [sa, sb, all] = [new Sketch(), new Sketch(), new Sketch()];
    a.forEach((x) => { sa.add(x); all.add(x); });
    b.forEach((x) => { sb.add(x); all.add(x); });
    sa.merge(sb);
    for (const q of [0.5, 0.95, 0.99]) expect(sa.quantile(q)).toBe(all.quantile(q));
    // y NO es la media de percentiles (el error clásico):
    const naive = (new Sketch().add && (() => { const x = new Sketch(), y = new Sketch(); a.forEach((v) => x.add(v)); b.forEach((v) => y.add(v)); return (x.quantile(0.99)! + y.quantile(0.99)!) / 2; })())!;
    const exact = exactQuantile([...a, ...b], 0.99);
    expect(Math.abs(sa.quantile(0.99)! - exact) / exact).toBeLessThan(0.011);
    expect(Math.abs(naive - exact) / exact).toBeGreaterThan(0.05);
  });

  it('round-trips through serialisation and handles zeros / empty / out-of-range q', () => {
    const sk = new Sketch();
    [0, 0, 0, 1, 10, 100].forEach((v) => sk.add(v));
    const back = Sketch.deserialize(sk.serialize());
    expect(back.count).toBe(6);
    expect(back.quantile(0.1)).toBe(0);
    expect(back.quantile(1)).toBeCloseTo(100, -1);
    expect(back.quantile(5)).toBe(back.quantile(1)); // q > 1 se acota
    expect(new Sketch().quantile(0.5)).toBeNull();
  });

  it('refuses to merge sketches of different accuracy', () => {
    expect(() => new Sketch(0.01).merge(new Sketch(0.05))).toThrow();
  });
});

describe('Cell (monoide de agregación)', () => {
  const build = (vals: Array<[number, number]>, sketch = false) => {
    const c = newCell(sketch);
    for (const [v, ts] of vals) addValue(c, v, ts);
    return c;
  };
  it('merge is order-independent (commutative/associative) and `last` follows the newest timestamp', () => {
    const parts = [build([[1, 10], [5, 11]]), build([[9, 30]]), build([[2, 20], [7, 12]])];
    const forward = parts.reduce((acc, p) => mergeCell(acc, p), newCell(false));
    const backward = [...parts].reverse().reduce((acc, p) => mergeCell(acc, p), newCell(false));
    expect(forward).toEqual(backward);
    expect(forward).toMatchObject({ count: 5, sum: 24, min: 1, max: 9, last: 9, lastTs: 30 });
  });
  it('computes aggregations; percentiles are clamped to the observed range', () => {
    const c = build([[10, 1], [20, 2], [30, 3]], true);
    expect(computeAgg(c, 'avg', 10)).toBe(20);
    expect(computeAgg(c, 'rate', 10)).toBe(6);
    expect(computeAgg(c, 'count', 10)).toBe(3);
    const p99 = computeAgg(c, 'p99', 10)!;
    expect(p99).toBeLessThanOrEqual(30);
    expect(computeAgg(newCell(false), 'avg', 10)).toBeNull();
  });
});

describe('series validation and cardinality', () => {
  it('canonical key does not depend on label order', () => {
    expect(seriesKey('m', { b: '2', a: '1' })).toBe(seriesKey('m', { a: '1', b: '2' }));
  });
  it('rejects malformed names and labels', () => {
    expect(() => validateName('9bad')).toThrow(ValidationError);
    expect(() => validateName('has space')).toThrow(ValidationError);
    expect(() => validateLabels({ 'bad-key': 'x' })).toThrow(ValidationError);
    expect(() => validateLabels({ k: 'x'.repeat(200) })).toThrow(ValidationError);
    expect(() => validateLabels(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v'])))).toThrow(/too many/);
    expect(validateLabels(undefined)).toEqual({});
  });
  it('enforces per-metric and global series caps, and the type of a metric is fixed', () => {
    const reg = new SeriesRegistry(2, 3);
    const add = (name: string, id: number, user: string, type: 'gauge' | 'counter' = 'gauge') => {
      const key = seriesKey(name, { user });
      if (!reg.resolve(name, type, key)) reg.register({ id, name, type, labels: { user }, key });
    };
    add('m', 1, 'a'); add('m', 2, 'b');
    expect(() => add('m', 3, 'c')).toThrow(CardinalityError); // tope por métrica
    add('n', 3, 'a');
    expect(() => add('o', 4, 'a')).toThrow(CardinalityError); // tope global
    expect(() => add('m', 9, 'a', 'counter')).toThrow(TypeConflictError);
    add('m', 1, 'a'); // una serie existente sigue aceptándose aunque se alcanzara el tope
  });
});

describe('ingestion → store → query', () => {
  it('aggregates at receive time: thousands of points in one 10 s window become ONE row', () => {
    const { ingestor, store, clock } = makeSystem();
    const points = Array.from({ length: 5000 }, (_, i) => ({ name: 'cpu', labels: { host: 'a' }, value: i % 100, ts: clock.now() + (i % 9000) }));
    ingestor.ingest(points);
    ingestor.flush();
    expect(store.counts().buckets_10s).toBe(1);
    const res = runQuery(store, ingestor.registry, { metric: 'cpu', agg: 'count', from: T0, to: T0 + 60_000, stepSec: 10 }, clock.now());
    expect(res.series[0]!.points).toEqual([[T0, 5000]]);
  });

  it('rejects only the bad points of a batch and reports why', () => {
    const { ingestor } = makeSystem();
    const r = ingestor.ingest([
      { name: 'ok', value: 1 },
      { name: '9bad', value: 1 },
      { name: 'nan', value: NaN },
      { name: 'neg', type: 'timer', value: -5 },
      { name: 'future', value: 1, ts: T0 + 3_600_000 },
      { name: 'old', value: 1, ts: T0 - 30 * 86_400_000 },
      { name: 'ok', value: 2 },
    ]);
    expect(r.accepted).toBe(2);
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('answers sum / avg / rate / max / last with step buckets', () => {
    const { ingestor, store, registry, clock } = makeSystem();
    for (let s = 0; s < 120; s++) ingestor.ingest([{ name: 'reqs', type: 'counter', value: 10, ts: T0 + s * 1000 }]);
    ingestor.flush();
    const q = (agg: string) => runQuery(store, registry, { metric: 'reqs', agg, from: T0, to: T0 + 120_000, stepSec: 60 }, clock.now()).series[0]!.points;
    expect(q('sum')).toEqual([[T0, 600], [T0 + 60_000, 600]]);
    expect(q('rate')).toEqual([[T0, 10], [T0 + 60_000, 10]]); // 10 eventos/s
    expect(q('count')[0]![1]).toBe(60);
    expect(q('max')[0]![1]).toBe(10);
  });

  it('groups by label, filters, and merges series inside a group (sum of two hosts)', () => {
    const { ingestor, store, registry, clock } = makeSystem();
    ingestor.ingest([
      { name: 'reqs', type: 'counter', labels: { svc: 'api', host: 'h1' }, value: 3 },
      { name: 'reqs', type: 'counter', labels: { svc: 'api', host: 'h2' }, value: 4 },
      { name: 'reqs', type: 'counter', labels: { svc: 'web', host: 'h1' }, value: 100 },
    ]);
    ingestor.flush();
    const base = { metric: 'reqs', agg: 'sum', from: T0, to: T0 + 60_000, stepSec: 60 };
    const bySvc = runQuery(store, registry, { ...base, groupBy: ['svc'] }, clock.now());
    expect(bySvc.series.map((s) => [s.labels.svc, s.points[0]![1]])).toEqual([['api', 7], ['web', 100]]);
    const filtered = runQuery(store, registry, { ...base, filters: { svc: 'api' } }, clock.now());
    expect(filtered.series[0]!.points[0]![1]).toBe(7);
    const either = runQuery(store, registry, { ...base, filters: { host: 'h1,h2' } }, clock.now());
    expect(either.series[0]!.points[0]![1]).toBe(107);
  });

  it('percentiles stay correct after grouping several series (not an average of p99s)', () => {
    const { ingestor, store, registry, clock } = makeSystem();
    const r = rng(3);
    const fast = Array.from({ length: 4000 }, () => 20 + 10 * r());
    const slow = Array.from({ length: 1000 }, () => 800 + 400 * r());
    ingestor.ingest(fast.map((v) => ({ name: 'lat', type: 'timer' as const, labels: { host: 'fast' }, value: v })));
    ingestor.ingest(slow.map((v) => ({ name: 'lat', type: 'timer' as const, labels: { host: 'slow' }, value: v })));
    ingestor.flush();
    const p99 = runQuery(store, registry, { metric: 'lat', agg: 'p99', from: T0, to: T0 + 60_000, stepSec: 60 }, clock.now()).series[0]!.points[0]![1];
    const exact = exactQuantile([...fast, ...slow], 0.99);
    expect(Math.abs(p99 - exact) / exact).toBeLessThan(0.012);
  });

  it('validates queries: unknown agg, percentile on a counter, inverted range, too many points', () => {
    const { ingestor, store, registry, clock } = makeSystem();
    ingestor.ingest([{ name: 'c', type: 'counter', value: 1 }]);
    ingestor.flush();
    const base = { metric: 'c', agg: 'sum', from: T0, to: T0 + 60_000, stepSec: 10 };
    expect(() => runQuery(store, registry, { ...base, agg: 'median' }, clock.now())).toThrow(QueryError);
    expect(() => runQuery(store, registry, { ...base, agg: 'p99' }, clock.now())).toThrow(/timer/);
    expect(() => runQuery(store, registry, { ...base, to: T0 }, clock.now())).toThrow(QueryError);
    expect(() => runQuery(store, registry, { ...base, to: T0 + 3_600_000 * 100 }, clock.now())).toThrow(/too many points/);
    expect(runQuery(store, registry, { ...base, metric: 'nope' }, clock.now()).series).toEqual([]);
  });
});

describe('query planner', () => {
  const tiers = tiersOf({ RETENTION_10S_HOURS: 6, RETENTION_1M_DAYS: 14, RETENTION_1H_DAYS: 400 });
  const now = T0;
  it('picks the finest tier that still has the data and fits the step', () => {
    expect(pickTier(tiers, now - 3_600_000, 10_000, now).name).toBe('10s');
    expect(pickTier(tiers, now - 3_600_000, 300_000, now).name).toBe('1m'); // paso grueso: no hace falta el fino
    expect(pickTier(tiers, now - 86_400_000, 10_000, now).name).toBe('1m'); // el nivel de 10 s ya expiró
    expect(pickTier(tiers, now - 90 * 86_400_000, 60_000, now).name).toBe('1h');
    expect(pickTier(tiers, now - 900 * 86_400_000, 60_000, now).name).toBe('1h'); // más allá de todo: lo más grueso
  });
});

describe('backpressure and flush safety', () => {
  it('sheds load with Overloaded (429) when the pending buffer is full, instead of growing unbounded', () => {
    const { ingestor } = makeSystem({ MAX_PENDING_KEYS: '10', FLUSH_AT_KEYS: '1000000' });
    ingestor.ingest(Array.from({ length: 10 }, (_, i) => ({ name: 'm', labels: { i: String(i) }, value: 1 })));
    expect(() => ingestor.ingest([{ name: 'm', value: 1 }])).toThrow(Overloaded);
    expect(ingestor.stats.rejectedShed).toBe(1);
    ingestor.flush(); // al vaciar, vuelve a aceptar
    expect(() => ingestor.ingest([{ name: 'm', value: 1 }])).not.toThrow();
  });

  it('counts cardinality rejections without breaking existing series', () => {
    const { ingestor } = makeSystem({ MAX_SERIES_PER_METRIC: '3' });
    const pts = Array.from({ length: 10 }, (_, i) => ({ name: 'req', labels: { user: `u${i}` }, value: 1 }));
    const r = ingestor.ingest(pts);
    expect(r.accepted).toBe(3);
    expect(r.rejected).toHaveLength(7);
    expect(ingestor.stats.rejectedCardinality).toBe(7);
    expect(ingestor.ingest([{ name: 'req', labels: { user: 'u0' }, value: 1 }]).accepted).toBe(1);
  });

  it('a failed flush returns the batch to the buffer: no data is lost, and the retry merges correctly', () => {
    const { ingestor, store, registry, clock } = makeSystem();
    ingestor.ingest([{ name: 'm', type: 'counter', value: 5 }]);
    const original = store.writeBatch.bind(store);
    store.writeBatch = () => { throw new Error('disk full'); };
    expect(() => ingestor.flush()).toThrow('disk full');
    ingestor.ingest([{ name: 'm', type: 'counter', value: 7 }]); // llega más durante el fallo
    store.writeBatch = original;
    ingestor.flush();
    const sum = runQuery(store, registry, { metric: 'm', agg: 'sum', from: T0, to: T0 + 60_000, stepSec: 60 }, clock.now()).series[0]!.points[0]![1];
    expect(sum).toBe(12);
  });
});

describe('instant (window) query', () => {
  it('covers exactly the last N seconds regardless of bucket alignment', () => {
    const { ingestor, store, registry, clock } = makeSystem();
    for (let s = 0; s < 100; s++) ingestor.ingest([{ name: 'g', value: s < 50 ? 100 : 10, ts: T0 + s * 1000 }]);
    ingestor.flush();
    clock.set(T0 + 99_999);
    const avg = instantQuery(store, registry, { metric: 'g', agg: 'avg', windowSec: 30 }, clock.now()).get('{}')!.value;
    expect(avg).toBe(10); // solo valores recientes; los antiguos (100) quedan fuera
  });
});
