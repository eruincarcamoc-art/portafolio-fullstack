import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { System } from '../system.js';
import { getOrder, IdempotencyConflict, listOrders, placeOrder, placeOrderSchema, timeline } from '../services/orders.js';
import { dashboardHtml } from './dashboard.js';

export interface AppOptions {
  system: System;
  /** Si se define, las rutas /api/admin/* exigen `Authorization: Bearer <token>`. */
  adminToken?: string;
  logger?: boolean;
}

const uuid = z.string().uuid();

export async function buildApp({ system, adminToken, logger = false }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger, bodyLimit: 256 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation_failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof IdempotencyConflict) return reply.status(422).send({ error: 'idempotency_key_reuse', message: err.message });
    const status = (err as any).statusCode as number | undefined;
    if (status && status < 500) return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal' });
  });

  const requireAdmin = async (req: FastifyRequest) => {
    if (!adminToken) return;
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(adminToken);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw Object.assign(new Error('Admin token required'), { statusCode: 401 });
    }
  };

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/', async (_req, reply) => reply.type('text/html').send(dashboardHtml(Boolean(adminToken))));

  // ------------------------------------------------------------ pedidos
  app.post('/api/orders', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
      return reply.status(400).send({ error: 'idempotency_key_required', message: 'Send an Idempotency-Key header (8-100 chars).' });
    }
    const input = placeOrderSchema.parse(req.body);
    const r = await placeOrder(system.db, input, key, system.now());
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.status(r.statusCode).send(r.body);
  });

  app.get('/api/orders', async () => ({ items: await listOrders(system.db) }));

  app.get('/api/orders/:id', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const order = await getOrder(system.db, id);
    return order ?? reply.status(404).send({ error: 'not_found' });
  });

  app.get('/api/orders/:id/timeline', async (req) => ({ events: await timeline(system.db, uuid.parse((req.params as any).id)) }));

  // ------------------------------------------------------------ operación (DLQ, colas, caos)
  app.get('/api/admin/queues', { preHandler: requireAdmin }, async () => ({ queues: await system.broker.stats(system.now()) }));

  app.get('/api/admin/dlq', { preHandler: requireAdmin }, async (req) => {
    const consumer = z.object({ consumer: z.string().optional() }).parse(req.query).consumer;
    return { items: await system.broker.deadLetters(consumer) };
  });

  app.post('/api/admin/dlq/:id/replay', { preHandler: requireAdmin }, async (req, reply) => {
    const id = z.coerce.number().int().positive().parse((req.params as any).id);
    return (await system.broker.replay(id, system.now())) ? { replayed: 1 } : reply.status(404).send({ error: 'not_dead' });
  });

  app.post('/api/admin/dlq/replay-all', { preHandler: requireAdmin }, async (req) => {
    const consumer = z.object({ consumer: z.string().optional() }).parse(req.query).consumer;
    return { replayed: await system.broker.replayAll(consumer, system.now()) };
  });

  app.get('/api/admin/chaos', { preHandler: requireAdmin }, async () => system.chaos);
  app.put('/api/admin/chaos', { preHandler: requireAdmin }, async (req) => {
    const patch = z
      .object({
        paymentTransientRate: z.number().min(0).max(1),
        paymentDeclineAboveCents: z.number().int().min(0).nullable(),
        mailerFailRate: z.number().min(0).max(1),
        inventoryBug: z.boolean(),
      })
      .partial()
      .parse(req.body);
    Object.assign(system.chaos, patch);
    return system.chaos;
  });

  app.get('/api/admin/stock', { preHandler: requireAdmin }, async () => ({
    items: await system.db.tx((q) => q.query(`SELECT sku, available, reserved FROM stock ORDER BY sku`)),
  }));

  app.put('/api/admin/stock/:sku', { preHandler: requireAdmin }, async (req) => {
    const sku = z.string().min(1).max(40).parse((req.params as any).sku);
    const { available } = z.object({ available: z.number().int().min(0).max(1_000_000) }).parse(req.body);
    await system.db.tx((q) =>
      q.query(`INSERT INTO stock(sku, available) VALUES ($1,$2) ON CONFLICT (sku) DO UPDATE SET available=$2`, [sku, available]),
    );
    return { sku, available };
  });

  // ------------------------------------------------------------ métricas (Prometheus)
  app.get('/metrics', async (_req, reply) => {
    const queues = await system.broker.stats(system.now());
    const gauge = (name: string, help: string, pick: (q: (typeof queues)[number]) => number) => ({
      name, help, type: 'gauge' as const,
      samples: queues.map((q) => ({ labels: { consumer: q.consumer }, value: pick(q) })),
    });
    return reply.type('text/plain; version=0.0.4').send(
      system.metrics.render([
        gauge('broker_queue_ready', 'Deliveries ready to be processed', (q) => q.ready),
        gauge('broker_queue_processing', 'Deliveries currently leased', (q) => q.processing),
        gauge('broker_queue_dead', 'Dead-letter deliveries', (q) => q.dead),
        gauge('broker_queue_oldest_ready_age_seconds', 'Consumer lag in seconds', (q) => q.oldestReadyAgeSec),
      ]),
    );
  });

  return app;
}
