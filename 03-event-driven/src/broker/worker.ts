import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Broker } from './broker.js';
import { writeOutbox } from './outbox.js';
import { Metrics } from './metrics.js';
import { DEFAULT_RETRY, type ConsumerDef, type Delivery, type RetryPolicy } from './types.js';

export interface WorkerOptions {
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  retry?: Partial<RetryPolicy>;
  now?: () => Date;
  rng?: () => number;
  workerId?: string;
  metrics?: Metrics;
  log?: (msg: string, extra?: object) => void;
}

class LeaseLostError extends Error {}

/**
 * Ejecuta un consumidor. Por cada entrega, en UNA transacción:
 *   1. inserta en processed_messages (si ya existe => duplicado: se omite el handler),
 *   2. ejecuta el handler (efectos + eventos de salida al outbox),
 *   3. marca la entrega como done comprobando que seguimos siendo el dueño del lease.
 * Si algo falla, todo se revierte y se programa un reintento (o DLQ) en otra transacción.
 */
export class Worker {
  readonly workerId: string;
  private readonly opts: Required<Omit<WorkerOptions, 'retry' | 'workerId'>> & { retry: RetryPolicy };
  private running = false;
  private inflight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: Db,
    private readonly broker: Broker,
    readonly def: ConsumerDef,
    options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `${def.name}-${randomUUID().slice(0, 8)}`;
    this.opts = {
      concurrency: options.concurrency ?? 4,
      leaseMs: options.leaseMs ?? 30_000,
      pollMs: options.pollMs ?? 100,
      now: options.now ?? (() => new Date()),
      rng: options.rng ?? Math.random,
      metrics: options.metrics ?? new Metrics(),
      log: options.log ?? (() => {}),
      retry: { ...DEFAULT_RETRY, ...(def.maxAttempts ? { maxAttempts: def.maxAttempts } : {}), ...options.retry },
    };
  }

  /** Reclama y procesa un lote. Devuelve cuántas entregas se intentaron. */
  async runOnce(): Promise<number> {
    const batch = await this.broker.claim(this.def.name, this.workerId, this.opts.concurrency, this.opts.leaseMs, this.opts.now());
    await Promise.all(batch.map((d) => this.process(d)));
    return batch.length;
  }

  private async process(d: Delivery): Promise<void> {
    const { metrics } = this.opts;
    const labels = { consumer: this.def.name };
    const started = Date.now();
    try {
      await this.db.tx(async (q) => {
        const now = this.opts.now();
        const first = await q.query(
          `INSERT INTO processed_messages(consumer, message_id, processed_at) VALUES ($1,$2,$3::timestamptz)
           ON CONFLICT DO NOTHING RETURNING message_id`,
          [this.def.name, d.messageId, now],
        );
        if (first.length) {
          await this.def.handler({
            q,
            msg: d.message,
            attempt: d.attempts,
            now,
            emit: async (topic, payload, key) => {
              await writeOutbox(q, { source: this.def.name, topic, key: key ?? d.message.key, payload, now });
            },
          });
        } else {
          metrics.inc('broker_duplicates_skipped_total', labels);
        }
        const done = await q.query(
          `UPDATE deliveries SET state='done', completed_at=$3::timestamptz, updated_at=$3::timestamptz, locked_by=NULL, locked_until=NULL
            WHERE id=$1 AND locked_by=$2 AND state='processing' RETURNING id`,
          [d.id, this.workerId, now],
        );
        // Fencing: si el lease venció y otro worker tomó la entrega, revertimos todo para no duplicar efectos.
        if (!done.length) throw new LeaseLostError();
      });
      metrics.inc('broker_processed_total', labels);
      metrics.inc('broker_processing_ms_sum', labels, Date.now() - started);
    } catch (err) {
      if (err instanceof LeaseLostError) {
        metrics.inc('broker_lease_lost_total', labels);
        return;
      }
      const outcome = await this.broker.fail(d, this.workerId, err, this.opts.now(), this.opts.retry, this.opts.rng);
      metrics.inc('broker_failures_total', { ...labels, outcome });
      this.opts.log('delivery failed', { consumer: this.def.name, delivery: d.id, attempt: d.attempts, outcome, error: String(err) });
    }
  }

  // ---------- ciclo de vida ----------
  start(onError: (e: unknown) => void = () => {}): void {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      let n = 0;
      const p = this.runOnce().then((c) => void (n = c), onError);
      this.inflight.add(p);
      await p;
      this.inflight.delete(p);
      if (this.running) this.timer = setTimeout(loop, n > 0 ? 0 : this.opts.pollMs);
    };
    void loop();
  }

  /** Apagado ordenado: deja de reclamar y espera a que terminen las entregas en curso. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.all([...this.inflight]);
  }
}
