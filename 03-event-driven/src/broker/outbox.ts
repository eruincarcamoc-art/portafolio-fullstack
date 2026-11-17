import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/index.js';
import type { Broker } from './broker.js';

/**
 * Transactional outbox: en lugar de "guardar y luego publicar" (dos escrituras que pueden quedar a medias),
 * el evento se inserta en la MISMA transacción que el cambio de estado. Un relay lo publica después.
 * => nunca hay un cambio sin evento, ni un evento sin cambio.
 */
export async function writeOutbox(
  q: Queryable,
  e: { source: string; topic: string; key: string; payload: unknown; now: Date },
): Promise<string> {
  const id = randomUUID();
  await q.query(
    `INSERT INTO outbox(message_id, source, topic, key, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6::timestamptz)`,
    [id, e.source, e.topic, e.key, JSON.stringify(e.payload), e.now],
  );
  return id;
}

export interface RelayHooks {
  /** Solo para tests de caos: se invoca tras publicar y antes de marcar como publicado. */
  afterPublish?: () => void | Promise<void>;
}

/**
 * Lleva los eventos del outbox al broker. Es AT-LEAST-ONCE: si cae entre publicar y marcar, el siguiente
 * ciclo republica, y el broker descarta el duplicado por message_id. Es seguro ejecutar varios relays.
 */
export class Relay {
  constructor(
    private readonly db: Db,
    private readonly broker: Broker,
    private readonly now: () => Date = () => new Date(),
    private readonly batchSize = 200,
    private readonly hooks: RelayHooks = {},
  ) {}

  async runOnce(): Promise<number> {
    const rows = await this.db.tx((q) =>
      q.query<{ id: string; message_id: string; topic: string; key: string; payload: unknown }>(
        `SELECT id, message_id, topic, key, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1`,
        [this.batchSize],
      ),
    );
    if (!rows.length) return 0;
    await this.broker.publish(
      rows.map((r) => ({ id: r.message_id, topic: r.topic, key: r.key, payload: r.payload })),
      this.now(),
    );
    await this.hooks.afterPublish?.();
    await this.db.tx((q) =>
      q.query(`UPDATE outbox SET published_at = $2::timestamptz WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id), this.now()]),
    );
    return rows.length;
  }

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  start(intervalMs = 200, onError: (e: unknown) => void = () => {}): void {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      let n = 0;
      try {
        n = await this.runOnce();
      } catch (e) {
        onError(e);
      }
      if (this.running) this.timer = setTimeout(loop, n > 0 ? 0 : intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}
