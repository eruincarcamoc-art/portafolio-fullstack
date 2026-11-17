import type { Config } from './config.js';
import { addValue, newCell, type Cell } from './cell.js';
import { CardinalityError, METRIC_TYPES, seriesKey, SeriesRegistry, TypeConflictError, validateLabels, validateName, ValidationError, type MetricType } from './series.js';
import type { Store } from './store.js';

export interface IncomingPoint {
  name: string;
  type?: MetricType;
  labels?: Record<string, string>;
  value: number;
  /** Milisegundos epoch. Por defecto, ahora. */
  ts?: number;
}

export interface IngestResult {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

export class Overloaded extends Error {
  constructor(readonly retryAfterSec: number) {
    super('ingest queue is full; retry later');
  }
}

export interface IngestStats {
  accepted: number;
  rejectedInvalid: number;
  rejectedCardinality: number;
  rejectedShed: number;
  flushes: number;
  flushedBuckets: number;
  lastFlushMs: number;
  pendingKeys: number;
  series: number;
}

/**
 * Ingesta de alto volumen. Decisiones clave:
 *  - AGREGA AL RECIBIR: en vez de guardar cada punto, se acumula una celda por (serie, cubeta de 10 s) en memoria
 *    y se vuelca por lotes en UNA transacción. 100 000 puntos de la misma serie en 10 s son 1 fila, no 100 000.
 *  - BACKPRESSURE: la memoria está acotada (`MAX_PENDING_KEYS`); si el volcado no da abasto se responde 429 con
 *    Retry-After (load shedding) en vez de crecer hasta caerse.
 *  - CARDINALIDAD acotada y puntos inválidos rechazados individualmente (un punto malo no tumba el lote).
 */
export class Ingestor {
  private pending = new Map<string, { seriesId: number; ts: number; cell: Cell }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  readonly stats: IngestStats = {
    accepted: 0, rejectedInvalid: 0, rejectedCardinality: 0, rejectedShed: 0,
    flushes: 0, flushedBuckets: 0, lastFlushMs: 0, pendingKeys: 0, series: 0,
  };

  constructor(
    private readonly store: Store,
    readonly registry: SeriesRegistry,
    private readonly cfg: Pick<Config, 'MAX_PENDING_KEYS' | 'MAX_BATCH_POINTS' | 'FLUSH_MS' | 'FLUSH_AT_KEYS' | 'FUTURE_SKEW_SECONDS' | 'RETENTION_10S_HOURS'>,
    private readonly now: () => number = Date.now,
  ) {}

  ingest(points: IncomingPoint[]): IngestResult {
    if (points.length > this.cfg.MAX_BATCH_POINTS) throw new ValidationError(`batch too large (max ${this.cfg.MAX_BATCH_POINTS})`);
    // Backpressure ANTES de hacer trabajo.
    if (this.pending.size >= this.cfg.MAX_PENDING_KEYS) {
      this.stats.rejectedShed += points.length;
      throw new Overloaded(2);
    }

    const t = this.now();
    const maxTs = t + this.cfg.FUTURE_SKEW_SECONDS * 1000;
    const minTs = t - this.cfg.RETENTION_10S_HOURS * 3_600_000 + 60_000;
    const rejected: IngestResult['rejected'] = [];
    let accepted = 0;

    points.forEach((p, index) => {
      try {
        const name = validateName(p.name);
        const type: MetricType = p.type ?? 'gauge';
        if (!METRIC_TYPES.includes(type)) throw new ValidationError('invalid type');
        if (typeof p.value !== 'number' || !Number.isFinite(p.value)) throw new ValidationError('value must be a finite number');
        if (type === 'timer' && p.value < 0) throw new ValidationError('timer values must be >= 0');
        const ts = p.ts ?? t;
        if (!Number.isFinite(ts) || ts > maxTs) throw new ValidationError('timestamp too far in the future');
        if (ts < minTs) throw new ValidationError('timestamp older than the fine-grained retention');
        const labels = validateLabels(p.labels);

        const key = seriesKey(name, labels);
        let series = this.registry.resolve(name, type, key);
        if (!series) {
          series = this.store.createSeries(name, type, labels, key, t);
          this.registry.register(series);
        }
        const bucket = Math.floor(ts / 10_000) * 10_000;
        const pk = `${series.id}:${bucket}`;
        let entry = this.pending.get(pk);
        if (!entry) this.pending.set(pk, (entry = { seriesId: series.id, ts: bucket, cell: newCell(type === 'timer') }));
        addValue(entry.cell, p.value, ts);
        accepted++;
      } catch (e) {
        if (e instanceof CardinalityError) {
          this.stats.rejectedCardinality++;
          rejected.push({ index, reason: e.message });
        } else if (e instanceof ValidationError || e instanceof TypeConflictError) {
          this.stats.rejectedInvalid++;
          rejected.push({ index, reason: e.message });
        } else throw e;
      }
    });

    this.stats.accepted += accepted;
    this.stats.series = this.registry.size;
    this.stats.pendingKeys = this.pending.size;
    if (this.pending.size >= this.cfg.FLUSH_AT_KEYS) this.flush();
    else this.schedule();
    return { accepted, rejected };
  }

  private schedule(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => this.flush(), this.cfg.FLUSH_MS);
    this.timer.unref?.();
  }

  /** Vuelca lo acumulado. Síncrono (node:sqlite lo es): mientras vuelca, nadie escribe en `pending`. */
  flush(): number {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.flushing || this.pending.size === 0) return 0;
    this.flushing = true;
    const batch = this.pending;
    this.pending = new Map();
    const started = performance.now();
    try {
      const n = this.store.writeBatch(batch.values(), this.now());
      this.stats.flushes++;
      this.stats.flushedBuckets += n;
      return n;
    } catch (e) {
      // El volcado falló: se devuelve el lote a la cola (fusionando con lo que haya llegado) para no perder datos.
      for (const [k, v] of batch) {
        const cur = this.pending.get(k);
        if (cur) this.mergeInto(cur.cell, v.cell);
        else this.pending.set(k, v);
      }
      throw e;
    } finally {
      this.stats.lastFlushMs = Math.round((performance.now() - started) * 100) / 100;
      this.stats.pendingKeys = this.pending.size;
      this.flushing = false;
      if (this.pending.size) this.schedule();
    }
  }

  private mergeInto(a: Cell, b: Cell): void {
    a.count += b.count;
    a.sum += b.sum;
    a.min = Math.min(a.min, b.min);
    a.max = Math.max(a.max, b.max);
    if (b.lastTs >= a.lastTs) {
      a.last = b.last;
      a.lastTs = b.lastTs;
    }
    if (b.sketch) a.sketch ? a.sketch.merge(b.sketch) : (a.sketch = b.sketch);
  }

  /** Apagado ordenado: no se pierde lo que aún está en memoria. */
  close(): void {
    this.flush();
  }
}
