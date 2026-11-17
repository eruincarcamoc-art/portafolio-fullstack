import type { ConsumerDef } from '../broker/types.js';
import { PermanentError } from '../broker/types.js';
import { ALL_TOPICS, nextStatus, Topics, type OrderItem, type OrderStatus } from './events.js';
import type { Chaos, Mailer, PaymentGateway } from './gateway.js';

export interface Deps {
  gateway: PaymentGateway;
  mailer: Mailer;
  chaos: Chaos;
}

/**
 * Coreografía de la saga (cada servicio reacciona a eventos y emite los suyos; no hay orquestador central):
 *
 *   order.placed ─▶ inventory ──reserved──▶ payment ──succeeded──▶ shipping ─▶ shipment.created
 *                       │                      │
 *                       └─rejected             └─failed ─▶ inventory (COMPENSA: libera stock) ─▶ inventory.released
 *
 * `order-state` y `projector` observan todo; `notifications` avisa al cliente del resultado final.
 */
export function buildConsumers(deps: Deps): ConsumerDef[] {
  return [
    // ---------------------------------------------------------------- inventario
    {
      name: 'inventory',
      topics: [Topics.OrderPlaced, Topics.PaymentFailed],
      async handler({ q, msg, emit }) {
        if (deps.chaos.inventoryBug) throw new Error('TypeError: cannot read properties of undefined (reading "sku")');

        if (msg.topic === Topics.OrderPlaced) {
          const { orderId, customerId, items, totalCents } = msg.payload as {
            orderId: string; customerId: string; items: OrderItem[]; totalCents: number;
          };
          // Se bloquean las filas en orden de SKU: dos pedidos concurrentes nunca se interbloquean.
          const skus = [...new Set(items.map((i) => i.sku))].sort();
          const rows = await q.query<{ sku: string; available: number }>(
            `SELECT sku, available FROM stock WHERE sku = ANY($1::text[]) ORDER BY sku FOR UPDATE`,
            [skus],
          );
          const have = new Map(rows.map((r) => [r.sku, r.available]));
          const need = new Map<string, number>();
          for (const i of items) need.set(i.sku, (need.get(i.sku) ?? 0) + i.qty);
          const short = [...need].filter(([sku, qty]) => (have.get(sku) ?? 0) < qty).map(([sku]) => sku);

          if (short.length) {
            await emit(Topics.InventoryRejected, { orderId, reason: 'out_of_stock', skus: short });
            return;
          }
          for (const [sku, qty] of need) {
            await q.query(`UPDATE stock SET available = available - $2, reserved = reserved + $2 WHERE sku = $1`, [sku, qty]);
          }
          await q.query(`INSERT INTO reservations(order_id, items, status) VALUES ($1,$2,'reserved') ON CONFLICT DO NOTHING`, [
            orderId,
            JSON.stringify(items),
          ]);
          await emit(Topics.InventoryReserved, { orderId, customerId, amountCents: totalCents });
          return;
        }

        // payment.failed => compensación: devolver el stock reservado.
        if (msg.topic === Topics.PaymentFailed) {
          const { orderId } = msg.payload as { orderId: string };
          const r = await q.query<{ items: OrderItem[] }>(
            `UPDATE reservations SET status='released' WHERE order_id=$1 AND status='reserved' RETURNING items`,
            [orderId],
          );
          for (const item of r[0]?.items ?? []) {
            await q.query(`UPDATE stock SET available = available + $2, reserved = reserved - $2 WHERE sku = $1`, [item.sku, item.qty]);
          }
          await emit(Topics.InventoryReleased, { orderId });
        }
      },
    },

    // ---------------------------------------------------------------- pagos
    {
      name: 'payment',
      topics: [Topics.InventoryReserved],
      async handler({ q, msg, now, emit }) {
        const { orderId, amountCents } = msg.payload as { orderId: string; amountCents: number };
        try {
          // Llamada externa dentro del handler: si lanza un error transitorio se revierte y se reintenta.
          // La clave de idempotencia (orderId) evita cobrar dos veces si se reintenta tras un timeout ambiguo.
          const { ref } = await deps.gateway.charge({ orderId, amountCents });
          await q.query(
            `INSERT INTO payments(order_id, amount_cents, status, gateway_ref, created_at) VALUES ($1,$2,'succeeded',$3,$4::timestamptz) ON CONFLICT DO NOTHING`,
            [orderId, amountCents, ref, now],
          );
          await emit(Topics.PaymentSucceeded, { orderId, amountCents, ref });
        } catch (err) {
          if (!(err instanceof PermanentError)) throw err; // transitorio: reintento con backoff
          // Rechazo definitivo (tarjeta declinada): no se reintenta; se emite el evento que dispara la compensación.
          await q.query(
            `INSERT INTO payments(order_id, amount_cents, status, error, created_at) VALUES ($1,$2,'failed',$3,$4::timestamptz) ON CONFLICT DO NOTHING`,
            [orderId, amountCents, err.message, now],
          );
          await emit(Topics.PaymentFailed, { orderId, reason: err.message });
        }
      },
    },

    // ---------------------------------------------------------------- envíos
    {
      name: 'shipping',
      topics: [Topics.PaymentSucceeded],
      async handler({ q, msg, now, emit }) {
        const { orderId } = msg.payload as { orderId: string };
        const tracking = `TRK-${orderId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
        await q.query(`INSERT INTO shipments(order_id, tracking, created_at) VALUES ($1,$2,$3::timestamptz) ON CONFLICT DO NOTHING`, [
          orderId, tracking, now,
        ]);
        await emit(Topics.ShipmentCreated, { orderId, tracking });
      },
    },

    // ---------------------------------------------------------------- estado del pedido (modelo de escritura)
    {
      name: 'order-state',
      topics: ALL_TOPICS,
      async handler({ q, msg, now }) {
        const orderId = (msg.payload as { orderId: string }).orderId;
        const row = (await q.query<{ status: OrderStatus }>(`SELECT status FROM orders WHERE id=$1 FOR UPDATE`, [orderId]))[0];
        if (!row) return;
        const next = nextStatus(row.status, msg.topic);
        if (!next) return;
        await q.query(`UPDATE orders SET status=$2, cancel_reason=COALESCE($3, cancel_reason), updated_at=$4::timestamptz WHERE id=$1`, [
          orderId, next.status, next.reason ?? null, now,
        ]);
      },
    },

    // ---------------------------------------------------------------- notificaciones
    {
      name: 'notifications',
      topics: [Topics.ShipmentCreated, Topics.InventoryRejected, Topics.InventoryReleased],
      async handler({ q, msg, now }) {
        const orderId = (msg.payload as { orderId: string }).orderId;
        const order = (await q.query<{ customer_id: string }>(`SELECT customer_id FROM orders WHERE id=$1`, [orderId]))[0];
        if (!order) throw new Error('order not found yet'); // carrera improbable: se reintenta
        const kind = msg.topic === Topics.ShipmentCreated ? 'order_shipped' : 'order_cancelled';
        await deps.mailer.send(order.customer_id, kind);
        await q.query(`INSERT INTO notifications(order_id, kind, recipient, created_at) VALUES ($1,$2,$3,$4::timestamptz) ON CONFLICT DO NOTHING`, [
          orderId, kind, order.customer_id, now,
        ]);
      },
    },

    // ---------------------------------------------------------------- proyector (modelo de lectura, CQRS)
    {
      name: 'projector',
      topics: ALL_TOPICS,
      async handler({ q, msg, now }) {
        const p = msg.payload as { orderId: string; customerId?: string; totalCents?: number };
        await q.query(
          `INSERT INTO order_events(order_id, message_id, type, payload, occurred_at) VALUES ($1,$2,$3,$4,$5::timestamptz) ON CONFLICT DO NOTHING`,
          [p.orderId, msg.id, msg.topic, JSON.stringify(msg.payload), now],
        );
        const cur = (await q.query<{ status: OrderStatus }>(`SELECT status FROM order_view WHERE order_id=$1 FOR UPDATE`, [p.orderId]))[0];
        const next = nextStatus(cur?.status ?? 'PENDING', msg.topic);
        if (!cur) {
          await q.query(
            `INSERT INTO order_view(order_id, customer_id, total_cents, status, last_event, updated_at) VALUES ($1,$2,$3,$4,$5,$6::timestamptz) ON CONFLICT DO NOTHING`,
            [p.orderId, p.customerId ?? null, p.totalCents ?? null, next?.status ?? 'PENDING', msg.topic, now],
          );
        } else if (next) {
          await q.query(`UPDATE order_view SET status=$2, last_event=$3, updated_at=$4::timestamptz WHERE order_id=$1`, [
            p.orderId, next.status, msg.topic, now,
          ]);
        }
      },
    },
  ];
}
