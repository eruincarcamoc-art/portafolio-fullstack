import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import type { Db } from '../src/db/index.js';
import type { System } from '../src/system.js';
import { freshSystem } from './helpers.js';

let app: FastifyInstance;
let db: Db;
let system: System;
let clock: { advance(ms: number): void };

async function setup(adminToken?: string) {
  const s = await freshSystem();
  ({ db, system, clock } = s);
  app = await buildApp({ system, adminToken });
  await app.ready();
}
afterEach(async () => {
  await app?.close();
  await db?.close();
});

const body = { customerId: 'ana@example.com', items: [{ sku: 'KEYBOARD', qty: 1, priceCents: 2500 }] };
const post = (payload: unknown, key?: string) =>
  app.inject({ method: 'POST', url: '/api/orders', payload: payload as any, headers: key ? { 'idempotency-key': key } : {} });

describe('POST /api/orders (idempotent)', () => {
  it('requires an Idempotency-Key and validates the body', async () => {
    await setup();
    expect((await post(body)).statusCode).toBe(400);
    expect((await post(body, 'short')).statusCode).toBe(400);
    const bad = await post({ customerId: '', items: [] }, 'key-12345678');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('validation_failed');
    expect((await post({ ...body, items: [{ sku: 'X', qty: -1, priceCents: 1 }] }, 'key-12345678')).statusCode).toBe(400);
  });

  it('a retried request returns the SAME order (200 + replay header) instead of creating another', async () => {
    await setup();
    const first = await post(body, 'key-aaaaaaaa');
    expect(first.statusCode).toBe(201);
    const retry = await post(body, 'key-aaaaaaaa');
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json().id).toBe(first.json().id);
    const n = await db.tx(async (q) => (await q.query<any>(`SELECT count(*)::int c FROM orders`))[0].c);
    expect(n).toBe(1);
    const events = await db.tx(async (q) => (await q.query<any>(`SELECT count(*)::int c FROM outbox`))[0].c);
    expect(events).toBe(1); // un solo evento order.placed
  });

  it('reusing a key with a different body is rejected (422)', async () => {
    await setup();
    await post(body, 'key-bbbbbbbb');
    const r = await post({ ...body, customerId: 'other@example.com' }, 'key-bbbbbbbb');
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('idempotency_key_reuse');
  });

  it('simultaneous double-submit creates exactly one order', async () => {
    await setup();
    const [a, b] = await Promise.all([post(body, 'key-cccccccc'), post(body, 'key-cccccccc')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
  });
});

describe('reads and eventual consistency', () => {
  it('write model is immediately readable; the read model catches up after processing', async () => {
    await setup();
    const { id } = (await post(body, 'key-dddddddd')).json();
    expect((await app.inject({ url: `/api/orders/${id}` })).json()).toMatchObject({ id, status: 'PENDING', totalCents: 2500 });
    expect((await app.inject({ url: '/api/orders' })).json().items).toHaveLength(0); // aún no proyectado

    await system.drain();
    expect((await app.inject({ url: `/api/orders/${id}` })).json().status).toBe('SHIPPED');
    const list = (await app.inject({ url: '/api/orders' })).json().items;
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('SHIPPED');
    const tl = (await app.inject({ url: `/api/orders/${id}/timeline` })).json().events.map((e: any) => e.type);
    expect(tl).toEqual(['order.placed', 'inventory.reserved', 'payment.succeeded', 'shipment.created']);
  });

  it('returns 404 / 400 for unknown or malformed ids', async () => {
    await setup();
    expect((await app.inject({ url: '/api/orders/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/orders/not-a-uuid' })).statusCode).toBe(400);
  });
});

describe('admin: queues, DLQ, chaos, metrics', () => {
  it('shows queue depth, lets you inspect and replay dead letters', async () => {
    await setup();
    system.chaos.inventoryBug = true;
    await post(body, 'key-eeeeeeee');
    for (let i = 0; i < 8; i++) { clock.advance(60_000); await system.drain(); }

    const queues = (await app.inject({ url: '/api/admin/queues' })).json().queues;
    expect(queues.find((q: any) => q.consumer === 'inventory').dead).toBe(1);

    const dlq = (await app.inject({ url: '/api/admin/dlq?consumer=inventory' })).json().items;
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({ consumer: 'inventory', topic: 'order.placed', attempts: 5 });

    // arreglo + reintento desde la API
    await app.inject({ method: 'PUT', url: '/api/admin/chaos', payload: { inventoryBug: false } });
    expect((await app.inject({ method: 'POST', url: `/api/admin/dlq/${dlq[0].id}/replay` })).json()).toEqual({ replayed: 1 });
    expect((await app.inject({ method: 'POST', url: `/api/admin/dlq/${dlq[0].id}/replay` })).statusCode).toBe(404);
    await system.drain();
    const list = (await app.inject({ url: '/api/orders' })).json().items;
    expect(list[0].status).toBe('SHIPPED');
  });

  it('dashboard helper never sends a JSON content-type without a body (regression: Replay buttons returned 400)', async () => {
    await setup();
    const { dashboardHtml } = await import('../src/api/dashboard.js');
    expect(dashboardHtml(false)).toContain("if(o.body)h['content-type']='application/json'");
    // La petición que hacía el dashboard antes del arreglo era rechazada por Fastify:
    const bad = await app.inject({ method: 'POST', url: '/api/admin/dlq/replay-all', headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
    // y la que hace ahora (sin content-type) funciona:
    const good = await app.inject({ method: 'POST', url: '/api/admin/dlq/replay-all' });
    expect(good.statusCode).toBe(200);
  });

  it('validates chaos and stock updates', async () => {
    await setup();
    expect((await app.inject({ method: 'PUT', url: '/api/admin/chaos', payload: { paymentTransientRate: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/stock/MOUSE', payload: { available: -1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/stock/NEWSKU', payload: { available: 9 } })).statusCode).toBe(200);
    const stock = (await app.inject({ url: '/api/admin/stock' })).json().items;
    expect(stock.find((s: any) => s.sku === 'NEWSKU').available).toBe(9);
  });

  it('exposes Prometheus metrics including queue lag', async () => {
    await setup();
    await post(body, 'key-ffffffff');
    await system.relay.runOnce();
    clock.advance(3000);
    const text = (await app.inject({ url: '/metrics' })).body;
    expect(text).toContain('# TYPE broker_queue_ready gauge');
    expect(text).toMatch(/broker_queue_ready\{consumer="inventory"\} 1/);
    expect(text).toMatch(/broker_queue_oldest_ready_age_seconds\{consumer="inventory"\} 3/);
    await system.drain();
    expect((await app.inject({ url: '/metrics' })).body).toMatch(/broker_processed_total\{consumer="shipping"\} 1/);
  });

  it('protects admin routes with a bearer token when configured', async () => {
    await setup('s3cret-token');
    expect((await app.inject({ url: '/api/admin/queues' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/queues', headers: { authorization: 'Bearer wrong-token' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/queues', headers: { authorization: 'Bearer s3cret-token' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200); // lo público sigue público
  });

  it('serves the dashboard', async () => {
    await setup();
    const r = await app.inject({ url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('Orderflow');
  });
});
