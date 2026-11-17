import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { writeOutbox } from '../broker/outbox.js';
import { Topics } from './events.js';

export const placeOrderSchema = z.object({
  customerId: z.string().trim().min(1).max(100),
  items: z
    .array(
      z.object({
        sku: z.string().trim().min(1).max(40),
        qty: z.number().int().min(1).max(1000),
        priceCents: z.number().int().min(0).max(100_000_00),
      }),
    )
    .min(1)
    .max(50),
});
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

export class IdempotencyConflict extends Error {}

export interface PlaceOrderResult {
  statusCode: 201 | 200;
  replayed: boolean;
  body: { id: string; status: string; totalCents: number };
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * Crea un pedido de forma idempotente. En UNA transacción:
 *   - reserva la Idempotency-Key (PK única: si otro request la tiene, espera y luego ve su resultado),
 *   - inserta el pedido y su evento `order.placed` en el outbox,
 *   - guarda la respuesta para poder repetirla.
 * Reintentar el POST (red caída, doble clic) devuelve el MISMO pedido; no crea otro.
 * Misma clave con otro cuerpo => IdempotencyConflict (422): casi seguro es un bug del cliente.
 */
export async function placeOrder(db: Db, input: PlaceOrderInput, idempotencyKey: string, now: Date): Promise<PlaceOrderResult> {
  const requestHash = hash(input);
  return db.tx(async (q) => {
    const reserved = await q.query(
      `INSERT INTO idempotency_keys(key, request_hash, created_at) VALUES ($1,$2,$3::timestamptz) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [idempotencyKey, requestHash, now],
    );
    if (!reserved.length) {
      const prev = (await q.query<{ request_hash: string; response: PlaceOrderResult['body'] }>(
        `SELECT request_hash, response FROM idempotency_keys WHERE key=$1`, [idempotencyKey],
      ))[0]!;
      if (prev.request_hash !== requestHash) throw new IdempotencyConflict('Idempotency-Key was already used with a different request body');
      return { statusCode: 200, replayed: true, body: prev.response };
    }

    const id = randomUUID();
    const totalCents = input.items.reduce((s, i) => s + i.qty * i.priceCents, 0);
    await q.query(
      `INSERT INTO orders(id, customer_id, items, total_cents, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'PENDING',$5::timestamptz,$5::timestamptz)`,
      [id, input.customerId, JSON.stringify(input.items), totalCents, now],
    );
    await writeOutbox(q, {
      source: 'orders',
      topic: Topics.OrderPlaced,
      key: id,
      payload: { orderId: id, customerId: input.customerId, items: input.items, totalCents },
      now,
    });
    const body = { id, status: 'PENDING', totalCents };
    await q.query(`UPDATE idempotency_keys SET status_code=201, response=$2 WHERE key=$1`, [idempotencyKey, JSON.stringify(body)]);
    return { statusCode: 201, replayed: false, body };
  });
}

export async function getOrder(db: Db, id: string) {
  return db.tx(async (q) => {
    const o = (await q.query(
      `SELECT id, customer_id AS "customerId", items, total_cents::int AS "totalCents", status, cancel_reason AS "cancelReason", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM orders WHERE id=$1`, [id],
    ))[0];
    return o ?? null;
  });
}

/** Lectura desde el modelo de lectura (CQRS): puede ir por detrás del de escritura unos instantes. */
export async function listOrders(db: Db, limit = 50) {
  return db.tx((q) =>
    q.query(
      `SELECT order_id AS id, customer_id AS "customerId", total_cents::int AS "totalCents", status, last_event AS "lastEvent", updated_at AS "updatedAt"
         FROM order_view ORDER BY updated_at DESC, order_id LIMIT $1`, [limit],
    ),
  );
}

export async function timeline(db: Db, id: string) {
  return db.tx((q) =>
    q.query(`SELECT type, payload, occurred_at AS "at" FROM order_events WHERE order_id=$1 ORDER BY id`, [id]),
  );
}
