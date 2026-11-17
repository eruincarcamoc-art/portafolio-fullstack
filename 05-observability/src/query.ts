import { type Agg, type Cell, cloneCell, computeAgg, isPercentile, mergeCell, parseAgg } from './cell.js';
import type { Labels, SeriesRegistry } from './series.js';
import type { Store, Tier } from './store.js';

export class QueryError extends Error {}

export interface QueryParams {
  metric: string;
  agg: string;
  /** Milisegundos epoch. */
  from: number;
  to: number;
  /** Paso en segundos (se redondea al múltiplo de la resolución del nivel elegido). */
  stepSec: number;
  groupBy?: string[];
  /** Igualdad exacta o lista separada por comas: {route: "/a,/b"}. */
  filters?: Record<string, string>;
}

export interface QueryResult {
  tier: Tier['name'];
  stepSec: number;
  from: number;
  to: number;
  agg: string;
  series: Array<{ labels: Labels; points: Array<[number, number]> }>;
}

export const MAX_POINTS_PER_SERIES = 5000;
export const MAX_SERIES_PER_QUERY = 500;

/**
 * Planificador: elige el nivel MÁS FINO que (a) todavía conserva datos desde `from` y (b) tiene resolución
 * <= paso pedido. Así una consulta de 1 h usa 10 s, una de 3 días usa 1 min y una de 6 meses usa 1 h, y el coste de
 * la consulta depende del nº de puntos pedidos, no del volumen ingerido.
 */
export function pickTier(tiers: Tier[], from: number, stepMs: number, now: number): Tier {
  const candidates = tiers.filter((t) => from >= now - t.retentionMs);
  const usable = candidates.length ? candidates : [tiers.at(-1)!];
  const fitting = usable.filter((t) => t.resMs <= stepMs);
  return fitting.length ? fitting.at(-1)! : usable[0]!;
}

export function runQuery(store: Store, registry: SeriesRegistry, q: QueryParams, now: number = Date.now()): QueryResult {
  const agg = parseAgg(q.agg);
  if (!agg) throw new QueryError(`unknown aggregation "${q.agg}"`);
  if (!(q.to > q.from)) throw new QueryError('`to` must be greater than `from`');
  if (q.stepSec < 1) throw new QueryError('step must be >= 1 second');

  const all = registry.seriesOf(q.metric);
  if (all.length === 0) return { tier: '10s', stepSec: q.stepSec, from: q.from, to: q.to, agg: q.agg, series: [] };

  const type = all[0]!.type;
  if (isPercentile(agg) && type !== 'timer') throw new QueryError(`percentiles require a timer metric ("${q.metric}" is a ${type})`);

  const tier = pickTier(store.tiers, q.from, q.stepSec * 1000, now);
  if (tier.name !== '10s') store.refreshRollupsFor(q.from, q.to, now);
  const stepMs = Math.max(tier.resMs, Math.ceil((q.stepSec * 1000) / tier.resMs) * tier.resMs);
  if ((q.to - q.from) / stepMs > MAX_POINTS_PER_SERIES) throw new QueryError(`too many points (max ${MAX_POINTS_PER_SERIES}); increase step`);

  const filters = Object.entries(q.filters ?? {}).map(([k, v]) => [k, new Set(v.split(','))] as const);
  const groupBy = q.groupBy ?? [];
  const matching = all.filter((s) => filters.every(([k, allowed]) => s.labels[k] !== undefined && allowed.has(s.labels[k]!)));

  // grupo -> (cubeta de paso -> celda fusionada)
  const groups = new Map<string, { labels: Labels; cells: Map<number, Cell> }>();
  for (const s of matching) {
    const glabels: Labels = {};
    for (const k of groupBy) if (s.labels[k] !== undefined) glabels[k] = s.labels[k]!;
    const gkey = JSON.stringify(glabels);
    let g = groups.get(gkey);
    if (!g) {
      if (groups.size >= MAX_SERIES_PER_QUERY) throw new QueryError(`too many result series (max ${MAX_SERIES_PER_QUERY}); add filters or fewer groupBy labels`);
      groups.set(gkey, (g = { labels: glabels, cells: new Map() }));
    }
    // El rango se alinea al paso para que las cubetas parciales de los extremos no den valores engañosos.
    const start = Math.floor(q.from / stepMs) * stepMs;
    for (const { ts, cell } of store.readTier(tier, s.id, start, q.to)) {
      const bucket = Math.floor(ts / stepMs) * stepMs;
      const acc = g.cells.get(bucket);
      if (acc) mergeCell(acc, cell);
      else g.cells.set(bucket, cloneCell(cell));
    }
  }

  const series = [...groups.values()]
    .map((g) => ({
      labels: g.labels,
      points: [...g.cells.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ts, cell]) => [ts, computeAgg(cell, agg as Agg, stepMs / 1000)] as [number, number | null])
        .filter((p): p is [number, number] => p[1] !== null),
    }))
    .filter((s) => s.points.length > 0)
    .sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)));

  return { tier: tier.name, stepSec: stepMs / 1000, from: q.from, to: q.to, agg: q.agg, series };
}

/**
 * Un único valor por grupo sobre una ventana deslizante [now - window, now]: es lo que evalúan las alertas.
 * NO se alinea a ningún paso: se fusionan todas las cubetas de la ventana en una sola celda por grupo
 * (si se alineara, "media de los últimos 60 s" solo vería los segundos del minuto en curso).
 */
export function instantQuery(
  store: Store,
  registry: SeriesRegistry,
  q: { metric: string; agg: string; windowSec: number; groupBy?: string[]; filters?: Record<string, string> },
  now: number,
): Map<string, { labels: Labels; value: number }> {
  const agg = parseAgg(q.agg);
  if (!agg) throw new QueryError(`unknown aggregation "${q.agg}"`);
  const all = registry.seriesOf(q.metric);
  const out = new Map<string, { labels: Labels; value: number }>();
  if (!all.length) return out;
  if (isPercentile(agg) && all[0]!.type !== 'timer') throw new QueryError(`percentiles require a timer metric`);

  const from = now - q.windowSec * 1000;
  const tier = pickTier(store.tiers, from, 10_000, now);
  if (tier.name !== '10s') store.refreshRollupsFor(from, now + 1, now);
  const start = Math.floor(from / tier.resMs) * tier.resMs;
  const filters = Object.entries(q.filters ?? {}).map(([k, v]) => [k, new Set(v.split(','))] as const);
  const groupBy = q.groupBy ?? [];

  const groups = new Map<string, { labels: Labels; cell: Cell | null }>();
  for (const s of all) {
    if (!filters.every(([k, allowed]) => s.labels[k] !== undefined && allowed.has(s.labels[k]!))) continue;
    const labels: Labels = {};
    for (const k of groupBy) if (s.labels[k] !== undefined) labels[k] = s.labels[k]!;
    const key = JSON.stringify(labels);
    const g = groups.get(key) ?? { labels, cell: null };
    for (const { cell } of store.readTier(tier, s.id, start, now + 1)) g.cell = g.cell ? mergeCell(g.cell, cell) : cloneCell(cell);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    const v = g.cell ? computeAgg(g.cell, agg, q.windowSec) : null;
    if (v !== null) out.set(key, { labels: g.labels, value: v });
  }
  return out;
}
