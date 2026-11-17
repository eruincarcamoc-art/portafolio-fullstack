import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Config } from './config.js';
import { type Cell, mergeCell, newCell } from './cell.js';
import { openDatabase, type Database } from './sqlite.js';
import { Sketch } from './sketch.js';
import type { Labels, MetricType, Series } from './series.js';

export interface Tier {
  name: '10s' | '1m' | '1h';
  table: string;
  resMs: number;
  retentionMs: number;
}

export const tiersOf = (cfg: Pick<Config, 'RETENTION_10S_HOURS' | 'RETENTION_1M_DAYS' | 'RETENTION_1H_DAYS'>): Tier[] => [
  { name: '10s', table: 'buckets_10s', resMs: 10_000, retentionMs: cfg.RETENTION_10S_HOURS * 3_600_000 },
  { name: '1m', table: 'buckets_1m', resMs: 60_000, retentionMs: cfg.RETENTION_1M_DAYS * 86_400_000 },
  { name: '1h', table: 'buckets_1h', resMs: 3_600_000, retentionMs: cfg.RETENTION_1H_DAYS * 86_400_000 },
];

const BUCKET_DDL = (t: string) => `
CREATE TABLE IF NOT EXISTS ${t} (
  series_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  count     INTEGER NOT NULL,
  sum       REAL NOT NULL,
  min       REAL NOT NULL,
  max       REAL NOT NULL,
  last      REAL NOT NULL,
  last_ts   INTEGER NOT NULL,
  sketch    TEXT,
  PRIMARY KEY (series_id, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ${t}_ts ON ${t}(ts);`;

interface BucketRow {
  series_id: number;
  ts: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
  last_ts: number;
  sketch: string | null;
}

export const rowToCell = (r: BucketRow): Cell => ({
  count: r.count, sum: r.sum, min: r.min, max: r.max, last: r.last, lastTs: r.last_ts,
  sketch: r.sketch ? Sketch.deserialize(r.sketch) : null,
});

export interface WriteItem {
  seriesId: number;
  ts: number; // inicio de la cubeta de 10 s
  cell: Cell;
}

/**
 * Almacén de series temporales sobre SQLite (WAL).
 *  - Tres niveles de resolución (10 s / 1 min / 1 h) con retención decreciente: lo reciente es detallado y barato
 *    de consultar, lo antiguo es grueso pero dura meses.
 *  - Los rollups se RECALCULAN desde el nivel inferior para las cubetas "sucias" (idempotente): los datos que
 *    llegan tarde corrigen los agregados en vez de perderse.
 */
export class Store {
  readonly db: Database;
  readonly tiers: Tier[];
  private readonly stmts = new Map<string, ReturnType<Database['prepare']>>();

  constructor(path: string, cfg: Pick<Config, 'RETENTION_10S_HOURS' | 'RETENTION_1M_DAYS' | 'RETENTION_1H_DAYS'>) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabase(path);
    this.tiers = tiersOf(cfg);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private stmt(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  private migrate(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS series (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL,
  labels    TEXT NOT NULL,
  key       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS series_name ON series(name);
CREATE TABLE IF NOT EXISTS dirty (tier TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (tier, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS alert_rules (id TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS alert_state (
  rule_id TEXT NOT NULL, group_key TEXT NOT NULL, state TEXT NOT NULL, since INTEGER NOT NULL,
  value REAL, labels TEXT NOT NULL DEFAULT '{}', last_notified INTEGER,
  PRIMARY KEY (rule_id, group_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, rule_id TEXT NOT NULL, rule_name TEXT NOT NULL,
  group_key TEXT NOT NULL, labels TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  value REAL, delivery TEXT NOT NULL DEFAULT 'none'
);
CREATE INDEX IF NOT EXISTS alert_events_ts ON alert_events(ts);
CREATE TABLE IF NOT EXISTS monitors (id TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at INTEGER NOT NULL);
${this.tiers.map((t) => BUCKET_DDL(t.table)).join('\n')}
`);
  }

  // ------------------------------------------------------------------ series
  loadSeries(): Series[] {
    return (this.stmt(`SELECT id, name, type, labels, key FROM series`).all() as any[]).map((r) => ({
      id: Number(r.id), name: r.name, type: r.type as MetricType, labels: JSON.parse(r.labels) as Labels, key: r.key,
    }));
  }

  createSeries(name: string, type: MetricType, labels: Labels, key: string, now: number): Series {
    const r = this.stmt(`INSERT INTO series(name, type, labels, key, created_at, last_seen) VALUES (?,?,?,?,?,?)`).run(
      name, type, JSON.stringify(labels), key, now, now,
    );
    return { id: Number(r.lastInsertRowid), name, type, labels, key };
  }

  // ------------------------------------------------------------------ escritura
  /**
   * Fusiona un lote de celdas en el nivel de 10 s dentro de UNA transacción.
   * - Numéricos: upsert en SQL (rápido, sin leer).
   * - Con sketch: hay que leer el sketch previo y fusionarlo en JS.
   */
  writeBatch(items: Iterable<WriteItem>, now: number): number {
    let n = 0;
    const upsert = this.stmt(`
INSERT INTO buckets_10s(series_id, ts, count, sum, min, max, last, last_ts, sketch) VALUES (?,?,?,?,?,?,?,?,?)
ON CONFLICT(series_id, ts) DO UPDATE SET
  count = count + excluded.count,
  sum   = sum + excluded.sum,
  min   = MIN(min, excluded.min),
  max   = MAX(max, excluded.max),
  last  = CASE WHEN excluded.last_ts >= last_ts THEN excluded.last ELSE last END,
  last_ts = MAX(last_ts, excluded.last_ts)`);
    const getSketch = this.stmt(`SELECT sketch FROM buckets_10s WHERE series_id=? AND ts=?`);
    const setSketch = this.stmt(`UPDATE buckets_10s SET sketch=? WHERE series_id=? AND ts=?`);
    const markDirty = this.stmt(`INSERT OR IGNORE INTO dirty(tier, ts) VALUES ('1m', ?)`);
    const touch = this.stmt(`UPDATE series SET last_seen=? WHERE id=?`);
    const touched = new Set<number>();

    this.db.exec('BEGIN');
    try {
      for (const { seriesId, ts, cell } of items) {
        upsert.run(seriesId, ts, cell.count, cell.sum, cell.min, cell.max, cell.last, cell.lastTs, null);
        if (cell.sketch) {
          const prev = (getSketch.get(seriesId, ts) as { sketch: string | null } | undefined)?.sketch;
          const merged = prev ? Sketch.deserialize(prev).merge(cell.sketch) : cell.sketch;
          setSketch.run(merged.serialize(), seriesId, ts);
        }
        markDirty.run(Math.floor(ts / 60_000) * 60_000);
        touched.add(seriesId);
        n++;
      }
      for (const id of touched) touch.run(now, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }

  // ------------------------------------------------------------------ lectura
  readTier(tier: Tier, seriesId: number, from: number, to: number): Array<{ ts: number; cell: Cell }> {
    const rows = this.stmt(`SELECT * FROM ${tier.table} WHERE series_id=? AND ts>=? AND ts<? ORDER BY ts`).all(seriesId, from, to) as unknown as BucketRow[];
    return rows.map((r) => ({ ts: r.ts, cell: rowToCell(r) }));
  }

  // ------------------------------------------------------------------ rollups
  /**
   * Recalcula las cubetas de 1 min (desde 10 s) y de 1 h (desde 1 min) que están "sucias".
   * Se recalculan desde la fuente en vez de sumar deltas: es idempotente y tolera datos tardíos.
   * Si el nivel inferior ya expiró para esa cubeta, NO se toca (recalcular borraría datos buenos).
   */
  rollup(now: number, maxBuckets = 5000): { rolled1m: number; rolled1h: number } {
    const [t10, t1m, t1h] = this.tiers as [Tier, Tier, Tier];
    const rolled1m = this.rollTier('1m', t10, t1m, now, maxBuckets, (ts) => Math.floor(ts / t1h.resMs) * t1h.resMs);
    const rolled1h = this.rollTier('1h', t1m, t1h, now, maxBuckets, null);
    return { rolled1m, rolled1h };
  }

  private rollTier(dirtyTier: string, src: Tier, dst: Tier, now: number, max: number, parentOf: ((ts: number) => number) | null): number {
    const dirty = this.stmt(`SELECT ts FROM dirty WHERE tier=? ORDER BY ts LIMIT ?`).all(dirtyTier, max) as Array<{ ts: number }>;
    if (!dirty.length) return 0;
    const rowsIn = this.stmt(`SELECT * FROM ${src.table} WHERE ts>=? AND ts<?`);
    const replace = this.stmt(`INSERT OR REPLACE INTO ${dst.table}(series_id, ts, count, sum, min, max, last, last_ts, sketch) VALUES (?,?,?,?,?,?,?,?,?)`);
    const del = this.stmt(`DELETE FROM dirty WHERE tier=? AND ts=?`);
    const markParent = this.stmt(`INSERT OR IGNORE INTO dirty(tier, ts) VALUES ('1h', ?)`);
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const { ts } of dirty) {
        // Fuente expirada (o a punto de): no recalcular.
        const sourceAlive = ts >= now - src.retentionMs + dst.resMs;
        if (sourceAlive) {
          const bySeries = new Map<number, Cell>();
          for (const r of rowsIn.all(ts, ts + dst.resMs) as unknown as BucketRow[]) {
            const cell = rowToCell(r);
            const acc = bySeries.get(r.series_id);
            if (acc) mergeCell(acc, cell);
            else bySeries.set(r.series_id, mergeCell(newCell(false), cell));
          }
          for (const [seriesId, c] of bySeries) {
            replace.run(seriesId, ts, c.count, c.sum, c.min, c.max, c.last, c.lastTs, c.sketch ? c.sketch.serialize() : null);
            n++;
          }
          if (bySeries.size && parentOf) markParent.run(parentOf(ts));
        }
        del.run(dirtyTier, ts);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }

  /**
   * Lectura fresca ("read-your-writes"): si hay cubetas sucias que solapan el rango pedido en un nivel agregado,
   * se refrescan ANTES de leer. Es incremental (solo lo sucio) e idempotente.
   */
  refreshRollupsFor(from: number, to: number, now: number): void {
    const dirty = this.stmt(`SELECT 1 FROM dirty WHERE ((tier='1m' AND ts >= ? AND ts < ?) OR (tier='1h' AND ts >= ? AND ts < ?)) LIMIT 1`).get(
      from - 60_000, to, from - 3_600_000, to,
    );
    if (dirty) this.rollup(now);
  }

  // ------------------------------------------------------------------ retención
  /** Borra lo que excede la retención de cada nivel y las series huérfanas. Devuelve los ids de series eliminadas. */
  applyRetention(now: number): { deleted: Record<string, number>; seriesRemoved: number[] } {
    const deleted: Record<string, number> = {};
    this.db.exec('BEGIN');
    try {
      for (const t of this.tiers) {
        deleted[t.name] = Number(this.stmt(`DELETE FROM ${t.table} WHERE ts < ?`).run(now - t.retentionMs).changes);
      }
      this.stmt(`DELETE FROM dirty WHERE ts < ?`).run(now - this.tiers[1]!.retentionMs);
      const longest = this.tiers.at(-1)!.retentionMs;
      const old = this.stmt(`SELECT id FROM series WHERE last_seen < ?`).all(now - longest) as Array<{ id: number }>;
      for (const { id } of old) this.stmt(`DELETE FROM series WHERE id=?`).run(id);
      this.db.exec('COMMIT');
      return { deleted, seriesRemoved: old.map((o) => Number(o.id)) };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    out.series = Number((this.stmt(`SELECT count(*) c FROM series`).get() as any).c);
    for (const t of this.tiers) out[`buckets_${t.name}`] = Number((this.stmt(`SELECT count(*) c FROM ${t.table}`).get() as any).c);
    out.dirty = Number((this.stmt(`SELECT count(*) c FROM dirty`).get() as any).c);
    return out;
  }

  close(): void {
    this.db.close();
  }
}
