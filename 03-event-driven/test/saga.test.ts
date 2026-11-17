import { describe, it, expect, afterEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import type { System } from '../src/system.js';
import { count, freshSystem, order, orderRow, stockRow } from './helpers.js';

let db: Db;
afterEach(() => db?.close());

async function setup() {
  const s = await freshSystem();
  db = s.db;
  return s;
}

/** Avanza el reloj en pasos y deja correr el sistema: simula el paso del tiempo (backoff, reintentos). */
async function runFor(system: System, clock: { advance(ms: number): void }, totalMs: number, stepMs = 5000) {
  for (let t = 0; t < totalMs; t += stepMs) {
    clock.advance(stepMs);
    await system.drain();
  }
}

const eventTypes = (id: string) => db.tx(async (q) => (await q.query<any>(`SELECT type FROM order_events WHERE order_id=$1 ORDER BY id`, [id])).map((r) => r.type));

describe('saga: happy path', () => {
  it('order → inventory → payment → shipping → notification, with eventual consistency', async () => {
    const { system } = await setup();
    const id = await order(system, [{ sku: 'KEYBOARD', qty: 2, priceCents: 5000 }]);

    // Justo tras aceptar el pedido, el procesamiento aún no ha ocurrido (asíncrono).
    expect((await orderRow(db, id)).status).toBe('PENDING');
    expect(await count(db, 'order_view')).toBe(0); // el modelo de lectura va por detrás

    await system.drain();

    expect((await orderRow(db, id)).status).toBe('SHIPPED');
    expect(await stockRow(db, 'KEYBOARD')).toEqual({ available: 98, reserved: 2 });
    expect(await count(db, 'payments', `order_id='${id}' AND status='succeeded'`)).toBe(1);
    expect(await count(db, 'shipments', `order_id='${id}'`)).toBe(1);
    expect(system.mailer.sent).toEqual([{ to: 'ana@example.com', subject: 'order_shipped' }]);
    expect(await eventTypes(id)).toEqual(['order.placed', 'inventory.reserved', 'payment.succeeded', 'shipment.created']);
    expect(await db.tx(async (q) => (await q.query<any>(`SELECT status FROM order_view WHERE order_id=$1`, [id]))[0].status)).toBe('SHIPPED');
  });
});

describe('saga: failures and compensation', () => {
  it('out of stock → order cancelled, no payment attempted, stock untouched', async () => {
    const { system } = await setup();
    const id = await order(system, [{ sku: 'MONITOR', qty: 6 }]); // solo hay 5
    await system.drain();
    expect(await orderRow(db, id)).toEqual({ status: 'CANCELLED', cancel_reason: 'out_of_stock' });
    expect(await stockRow(db, 'MONITOR')).toEqual({ available: 5, reserved: 0 });
    expect(system.gateway.attempts).toBe(0);
    expect(system.mailer.sent[0]!.subject).toBe('order_cancelled');
  });

  it('card declined → COMPENSATION releases the reserved stock and cancels the order', async () => {
    const { system } = await setup();
    system.chaos.paymentDeclineAboveCents = 5000;
    const id = await order(system, [{ sku: 'KEYBOARD', qty: 3, priceCents: 4000 }]); // 12 000 > 5 000
    await system.drain();

    expect(await orderRow(db, id)).toEqual({ status: 'CANCELLED', cancel_reason: 'payment_failed' });
    expect(await stockRow(db, 'KEYBOARD')).toEqual({ available: 100, reserved: 0 }); // stock devuelto
    expect(system.gateway.chargesCreated).toBe(0);
    expect(await eventTypes(id)).toEqual(['order.placed', 'inventory.reserved', 'payment.failed', 'inventory.released']);
    expect(await count(db, 'shipments')).toBe(0);
  });

  it('transient payment errors are retried with backoff and the customer is charged exactly once', async () => {
    const { system, clock } = await setup();
    system.chaos.paymentTransientRate = 1; // la pasarela está caída
    const id = await order(system, [{ sku: 'MOUSE', qty: 1 }]);

    await system.drain();
    expect((await orderRow(db, id)).status).toBe('RESERVED'); // atascado en el pago, pero no perdido
    const q = (await system.broker.stats(clock.now())).find((x) => x.consumer === 'payment')!;
    expect(q.pending).toBe(1);
    expect(q.dead).toBe(0);

    system.chaos.paymentTransientRate = 0; // la pasarela se recupera
    await runFor(system, clock, 30_000);
    expect((await orderRow(db, id)).status).toBe('SHIPPED');
    expect(system.gateway.chargesCreated).toBe(1);
    expect(system.metrics.get('broker_failures_total', { consumer: 'payment', outcome: 'retry' })).toBeGreaterThanOrEqual(1);
  });

  it('a bad deploy exhausts retries → DLQ → fix + replay → the order completes (no lost data)', async () => {
    const { system, clock } = await setup();
    system.chaos.inventoryBug = true;
    const id = await order(system, [{ sku: 'KEYBOARD' }]);

    await runFor(system, clock, 5 * 60_000, 20_000); // se agotan los 5 intentos
    const dead = await system.broker.deadLetters('inventory');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.last_error).toContain('TypeError');
    expect((await orderRow(db, id)).status).toBe('PENDING');

    system.chaos.inventoryBug = false; // "desplegamos el arreglo"
    expect(await system.broker.replayAll('inventory', clock.now())).toBe(1);
    await system.drain();
    expect((await orderRow(db, id)).status).toBe('SHIPPED');
    expect(await system.broker.deadLetters()).toHaveLength(0);
  });

  it('a failing notification provider does not affect the order outcome (isolated consumers)', async () => {
    const { system, clock } = await setup();
    system.chaos.mailerFailRate = 1;
    const id = await order(system, [{ sku: 'MOUSE' }]);
    await system.drain();
    expect((await orderRow(db, id)).status).toBe('SHIPPED'); // el pedido sigue adelante
    expect(await count(db, 'notifications')).toBe(0);

    system.chaos.mailerFailRate = 0;
    await runFor(system, clock, 30_000);
    expect(await count(db, 'notifications')).toBe(1); // se entrega cuando el proveedor vuelve
  });
});

describe('consistency guarantees', () => {
  it('never oversells under demand greater than stock', async () => {
    const { system } = await setup(); // MONITOR: 5 unidades
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await order(system, [{ sku: 'MONITOR' }], `u${i}@x.com`));
    await system.drain();
    const statuses = await Promise.all(ids.map(async (id) => (await orderRow(db, id)).status));
    expect(statuses.filter((s) => s === 'SHIPPED')).toHaveLength(5);
    expect(statuses.filter((s) => s === 'CANCELLED')).toHaveLength(7);
    expect(await stockRow(db, 'MONITOR')).toEqual({ available: 0, reserved: 5 });
  });

  it('a storm of redeliveries produces no duplicate effects (idempotent consumers)', async () => {
    const { system, clock } = await setup();
    const ids = [await order(system, [{ sku: 'KEYBOARD', qty: 2 }]), await order(system, [{ sku: 'MOUSE' }])];
    await system.drain();
    const before = {
      stock: await stockRow(db, 'KEYBOARD'),
      shipments: await count(db, 'shipments'),
      payments: await count(db, 'payments'),
      notifications: await count(db, 'notifications'),
      sent: system.mailer.sent.length,
      charges: system.gateway.chargesCreated,
      events: await count(db, 'order_events'),
    };
    // Todas las entregas vuelven a la cola, como tras una caída del broker o un ack perdido.
    await db.tx((q) => q.query(`UPDATE deliveries SET state='pending', attempts=0, available_at=$1::timestamptz`, [clock.now()]));
    await system.drain();
    expect({
      stock: await stockRow(db, 'KEYBOARD'),
      shipments: await count(db, 'shipments'),
      payments: await count(db, 'payments'),
      notifications: await count(db, 'notifications'),
      sent: system.mailer.sent.length,
      charges: system.gateway.chargesCreated,
      events: await count(db, 'order_events'),
    }).toEqual(before);
    for (const id of ids) expect((await orderRow(db, id)).status).toBe('SHIPPED');
    expect(system.metrics.get('broker_duplicates_skipped_total', { consumer: 'shipping' })).toBe(2);
  });

  it('a late or repeated event never moves an order backwards (monotonic state machine)', async () => {
    const { system } = await setup();
    const id = await order(system, [{ sku: 'MOUSE' }]);
    await system.drain();
    // Llega tarde un evento viejo con otro message_id (p. ej. un productor reenvió algo antiguo).
    await db.tx((q) => q.query(
      `INSERT INTO outbox(message_id, source, topic, key, payload, created_at) VALUES (gen_random_uuid(),'test','inventory.reserved',$1,$2,now())`,
      [id, JSON.stringify({ orderId: id, amountCents: 1000, customerId: 'x' })],
    ));
    await system.drain();
    expect((await orderRow(db, id)).status).toBe('SHIPPED');
  });

  it('events of a single order are handled in order even with many orders in flight', async () => {
    const { system } = await setup();
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(await order(system, [{ sku: i % 2 ? 'MOUSE' : 'KEYBOARD' }]));
    await system.drain();
    for (const id of ids) {
      expect(await eventTypes(id)).toEqual(['order.placed', 'inventory.reserved', 'payment.succeeded', 'shipment.created']);
    }
  });

  it('survives a randomized chaos run: every order ends in a terminal state with consistent stock', async () => {
    const { system, clock } = await setup();
    system.chaos.paymentDeclineAboveCents = 7000; // los pedidos caros son rechazados (compensación)
    for (let i = 0; i < 25; i++) {
      await order(system, [{ sku: ['KEYBOARD', 'MOUSE', 'MONITOR'][i % 3]!, qty: 1 + (i % 2), priceCents: 2000 + (i % 5) * 1500 }], `c${i}@x.com`);
    }
    // El rng del sistema es fijo (determinista), así que alternamos los interruptores: la pasarela y el email
    // se caen y se recuperan por turnos mientras el tiempo avanza.
    for (let round = 0; round < 40; round++) {
      system.chaos.paymentTransientRate = round % 2 === 0 ? 1 : 0;
      system.chaos.mailerFailRate = round % 3 === 0 ? 1 : 0;
      clock.advance(15_000);
      await system.drain();
    }
    system.chaos.paymentTransientRate = 0;
    system.chaos.mailerFailRate = 0;
    await runFor(system, clock, 5 * 60_000, 20_000);

    const rows = await db.tx((q) => q.query<any>(`SELECT id, status, items FROM orders`));
    expect(rows).toHaveLength(25);
    for (const r of rows) expect(['SHIPPED', 'CANCELLED']).toContain(r.status);
    expect(await count(db, 'deliveries', `state='dead'`)).toBe(0);
    expect(await count(db, 'deliveries', `state IN ('pending','processing')`)).toBe(0);
    // Conservación del stock: lo reservado == suma de lo enviado.
    const shippedQty = new Map<string, number>();
    for (const r of rows.filter((x: any) => x.status === 'SHIPPED')) for (const i of r.items) shippedQty.set(i.sku, (shippedQty.get(i.sku) ?? 0) + i.qty);
    for (const sku of ['KEYBOARD', 'MOUSE', 'MONITOR']) {
      const s = await stockRow(db, sku);
      expect(s.reserved).toBe(shippedQty.get(sku) ?? 0);
    }
    // Un cobro por pedido enviado, ni uno más.
    expect(system.gateway.chargesCreated).toBe(rows.filter((r: any) => r.status === 'SHIPPED').length);
    // El caos fue real: hubo reintentos y se dieron ambos desenlaces.
    expect(system.metrics.get('broker_failures_total', { consumer: 'payment', outcome: 'retry' })).toBeGreaterThan(5);
    expect(system.metrics.get('broker_failures_total', { consumer: 'notifications', outcome: 'retry' })).toBeGreaterThan(0);
    expect(rows.some((r: any) => r.status === 'SHIPPED')).toBe(true);
    expect(rows.some((r: any) => r.status === 'CANCELLED')).toBe(true);
  });
});
