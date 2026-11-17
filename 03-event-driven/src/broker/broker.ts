import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/index.js';
import { backoffMs, type Delivery, type RetryPolicy, DEFAULT_RETRY } from './types.js';

export interface PublishInput {
  id: string;
  topic: string;
  key: string;
  payload: unknown;
}

export interface QueueStats {
  consumer: string;
  pending: number;
  ready: number;
  processing: number;
  done: number;
  dead: number;
  /** Segundos que lleva esperando el mensaje listo más antiguo (el "lag" del consumidor). */
  oldestReadyAgeSec: number;
}

/**
 * Broker pub/sub con grupos de consumidores, implementado sobre Postgres.
 *
 * Garantías:
 *  - Entrega AT-LEAST-ONCE (reintentos, leases que vencen). La idempotencia se logra en el consumidor.
 *  - Orden FIFO POR CLAVE y por consumidor: un mensaje solo es reclamable si no hay otro anterior de la
 *    misma clave sin terminar. Claves distintas se procesan en paralelo.
 *  - Publicación idempotente: publicar dos veces el mismo `id` es inofensivo.
 *  - Competencia segura entre workers: FOR UPDATE SKIP LOCKED.
 */
export class Broker {
  constructor(private readonly db: Db) {}

  async subscribe(consumer: string, topics: string[]): Promise<void> {
    await this.db.tx(async (q) => {
      for (const t of topics) {
        await q.query(`INSERT INTO subscriptions(consumer, topic) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [consumer, t]);
      }
    });
  }

  /** Publica en lote. Fan-out: una entrega por cada consumidor suscrito al tema. Devuelve cuántos mensajes eran nuevos. */
  async publish(batch: PublishInput[], now: Date): Promise<number> {
    return this.db.tx(async (q) => {
      let fresh = 0;
      for (const m of batch) {
        const ins = await q.query(
          `INSERT INTO messages(id, topic, key, payload, published_at) VALUES ($1,$2,$3,$4,$5::timestamptz)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [m.id, m.topic, m.key, JSON.stringify(m.payload), now],
        );
        if (!ins.length) continue; // duplicado: ya publicado antes (p. ej. el relay cayó antes de marcarlo)
        fresh++;
        await q.query(
          `INSERT INTO deliveries(message_id, consumer, key, state, available_at, created_at, updated_at)
           SELECT $1, s.consumer, $3, 'pending', $4::timestamptz, $4::timestamptz, $4::timestamptz
             FROM subscriptions s WHERE s.topic = $2`,
          [m.id, m.topic, m.key, now],
        );
      }
      return fresh;
    });
  }

  /**
   * Reclama hasta `limit` entregas listas para `consumer` y les pone un lease.
   * Listas = pendientes con available_at vencido, o en proceso con el lease expirado (worker caído),
   * y sin otra entrega anterior de la misma clave sin terminar (orden por clave).
   */
  async claim(consumer: string, workerId: string, limit: number, leaseMs: number, now: Date): Promise<Delivery[]> {
    const until = new Date(now.getTime() + leaseMs);
    return this.db.tx(async (q) => {
      const claimed = await q.query<{ id: string; message_id: string; key: string; attempts: number }>(
        `WITH cand AS (
           SELECT d.id FROM deliveries d
            WHERE d.consumer = $1
              AND ((d.state = 'pending'    AND d.available_at <= $2::timestamptz)
                OR (d.state = 'processing' AND d.locked_until <= $2::timestamptz))
              AND NOT EXISTS (
                SELECT 1 FROM deliveries e
                 WHERE e.consumer = d.consumer AND e.key = d.key AND e.id < d.id
                   AND e.state IN ('pending','processing'))
            ORDER BY d.id
            LIMIT $4
            FOR UPDATE OF d SKIP LOCKED)
         UPDATE deliveries d
            SET state = 'processing', attempts = d.attempts + 1,
                locked_by = $5, locked_until = $3::timestamptz, updated_at = $2::timestamptz
           FROM cand WHERE d.id = cand.id
       RETURNING d.id, d.message_id, d.key, d.attempts`,
        [consumer, now, until, limit, workerId],
      );
      if (!claimed.length) return [];
      const msgs = await q.query<{ id: string; topic: string; key: string; payload: any }>(
        `SELECT id, topic, key, payload FROM messages WHERE id = ANY($1::uuid[])`,
        [claimed.map((c) => c.message_id)],
      );
      const byId = new Map(msgs.map((m) => [m.id, m]));
      return claimed
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((c) => ({
          id: Number(c.id),
          consumer,
          messageId: c.message_id,
          key: c.key,
          attempts: c.attempts,
          message: byId.get(c.message_id)!,
        }));
    });
  }

  /** Marca el fallo de una entrega: reintento con backoff, o DLQ si agotó intentos / el error es permanente. */
  async fail(
    d: Delivery,
    workerId: string,
    err: unknown,
    now: Date,
    policy: RetryPolicy = DEFAULT_RETRY,
    rng: () => number = Math.random,
  ): Promise<'retry' | 'dead' | 'lost'> {
    const permanent = (err as any)?.permanent === true;
    const dead = permanent || d.attempts >= policy.maxAttempts;
    const nextAt = new Date(now.getTime() + backoffMs(d.attempts, policy, rng));
    const message = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 500);
    const rows = await this.db.tx((q) =>
      q.query(
        `UPDATE deliveries
            SET state = $3, available_at = $4::timestamptz, last_error = $5,
                locked_by = NULL, locked_until = NULL, updated_at = $6::timestamptz
          WHERE id = $1 AND locked_by = $2 AND state = 'processing' RETURNING id`,
        [d.id, workerId, dead ? 'dead' : 'pending', dead ? now : nextAt, message, now],
      ),
    );
    if (!rows.length) return 'lost'; // otro worker ya tomó la entrega (lease vencido)
    return dead ? 'dead' : 'retry';
  }

  // ---------- operación / DLQ ----------
  async deadLetters(consumer?: string, limit = 100) {
    return this.db.tx((q) =>
      q.query(
        `SELECT d.id, d.consumer, d.key, d.attempts, d.last_error, d.updated_at, m.topic, m.payload, m.id AS message_id
           FROM deliveries d JOIN messages m ON m.id = d.message_id
          WHERE d.state = 'dead' AND ($1::text IS NULL OR d.consumer = $1)
          ORDER BY d.id DESC LIMIT $2`,
        [consumer ?? null, limit],
      ),
    );
  }

  /** Reencola una entrega muerta (tras corregir el bug o el sistema externo). Se reintenta desde cero. */
  async replay(deliveryId: number, now: Date): Promise<boolean> {
    const rows = await this.db.tx((q) =>
      q.query(
        `UPDATE deliveries SET state='pending', attempts=0, available_at=$2::timestamptz, last_error=NULL, updated_at=$2::timestamptz
          WHERE id=$1 AND state='dead' RETURNING id`,
        [deliveryId, now],
      ),
    );
    return rows.length > 0;
  }

  async replayAll(consumer: string | undefined, now: Date): Promise<number> {
    const rows = await this.db.tx((q) =>
      q.query(
        `UPDATE deliveries SET state='pending', attempts=0, available_at=$2::timestamptz, last_error=NULL, updated_at=$2::timestamptz
          WHERE state='dead' AND ($1::text IS NULL OR consumer=$1) RETURNING id`,
        [consumer ?? null, now],
      ),
    );
    return rows.length;
  }

  async stats(now: Date): Promise<QueueStats[]> {
    const rows = await this.db.tx((q: Queryable) =>
      q.query<any>(
        `SELECT consumer,
                count(*) FILTER (WHERE state='pending')::int AS pending,
                count(*) FILTER (WHERE state='pending' AND available_at <= $1::timestamptz)::int AS ready,
                count(*) FILTER (WHERE state='processing')::int AS processing,
                count(*) FILTER (WHERE state='done')::int AS done,
                count(*) FILTER (WHERE state='dead')::int AS dead,
                COALESCE(EXTRACT(EPOCH FROM ($1::timestamptz - min(available_at) FILTER (WHERE state='pending' AND available_at <= $1::timestamptz))), 0)::float AS oldest
           FROM deliveries GROUP BY consumer ORDER BY consumer`,
        [now],
      ),
    );
    return rows.map((r) => ({ ...r, oldestReadyAgeSec: Math.max(0, Math.round(r.oldest)) }));
  }
}

export const newMessageId = (): string => randomUUID();
