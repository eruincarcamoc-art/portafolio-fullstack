import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { Overloaded, type IncomingPoint } from './ingest.js';
import { QueryError, runQuery } from './query.js';
import { assertSafeUrlShape, UnsafeTargetError } from './net.js';
import { ValidationError } from './series.js';
import type { Runtime } from './runtime.js';
import { uiHtml } from './ui.js';

const num = (name: string) => z.coerce.number({ error: `${name} must be a number` });

const querySchema = z.object({
  metric: z.string().min(1).max(128),
  agg: z.string().default('avg'),
  /** Rango relativo en segundos (por defecto 1 h) o `from`/`to` absolutos en ms. */
  range: num('range').int().min(10).max(366 * 86_400).optional(),
  from: num('from').optional(),
  to: num('to').optional(),
  step: num('step').int().min(1).optional(),
  groupBy: z.string().max(300).optional(),
});

export async function buildApi(rt: Runtime, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const { cfg } = rt;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 8 * 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation_failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof Overloaded) return reply.status(429).header('Retry-After', String(err.retryAfterSec)).send({ error: 'overloaded', message: err.message });
    if (err instanceof QueryError || err instanceof ValidationError || err instanceof UnsafeTargetError) return reply.status(400).send({ error: 'bad_request', message: err.message });
    const status = (err as any).statusCode as number | undefined;
    if (status && status < 500) return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal' });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer');
  });

  const authenticate = async (req: FastifyRequest) => {
    if (!cfg.API_KEY) return;
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(cfg.API_KEY);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw Object.assign(new Error('Invalid or missing API key'), { statusCode: 401 });
  };
  const guard = { preHandler: authenticate };

  app.get('/health', async () => ({ status: 'ok', series: rt.registry.size }));
  app.get('/', async (_req, reply) => reply.type('text/html').send(uiHtml(Boolean(cfg.API_KEY), cfg.SIMULATE)));

  // ------------------------------------------------------------------ ingesta
  app.post('/v1/ingest', guard, async (req, reply) => {
    const body = z.object({ points: z.array(z.any()).max(cfg.MAX_BATCH_POINTS) }).parse(req.body);
    const r = rt.ingestor.ingest(body.points as IncomingPoint[]);
    return reply.status(r.rejected.length && r.accepted === 0 ? 400 : 202).send({ accepted: r.accepted, rejectedCount: r.rejected.length, rejected: r.rejected.slice(0, 20) });
  });

  // ------------------------------------------------------------------ consulta
  app.get('/v1/query', guard, async (req) => {
    const raw = req.query as Record<string, string>;
    const p = querySchema.parse(raw);
    const now = rt.now();
    const to = p.to ?? now;
    const from = p.from ?? to - (p.range ?? 3600) * 1000;
    const step = p.step ?? Math.max(10, Math.ceil((to - from) / 1000 / 120)); // ~120 puntos por defecto
    const filters: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (k.startsWith('f.')) filters[k.slice(2)] = String(v);
    rt.ingestor.flush(); // lectura fresca: lo que acaba de llegar ya es visible
    return runQuery(rt.store, rt.registry, { metric: p.metric, agg: p.agg, from, to, stepSec: step, groupBy: p.groupBy ? p.groupBy.split(',').filter(Boolean) : undefined, filters }, now);
  });

  app.get('/v1/metrics', guard, async () => ({ metrics: rt.registry.metrics() }));

  app.get('/v1/labels', guard, async (req) => {
    const { metric } = z.object({ metric: z.string().min(1) }).parse(req.query);
    const labels = new Map<string, Set<string>>();
    for (const s of rt.registry.seriesOf(metric)) for (const [k, v] of Object.entries(s.labels)) (labels.get(k) ?? labels.set(k, new Set()).get(k)!).add(v);
    return { labels: Object.fromEntries([...labels].map(([k, v]) => [k, [...v].sort().slice(0, 100)])) };
  });

  // ------------------------------------------------------------------ alertas
  app.get('/v1/rules', guard, async () => ({ rules: rt.alerts.listRules() }));
  app.post('/v1/rules', guard, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.webhook === 'string') assertSafeUrlShape(body.webhook, cfg.ALLOW_PRIVATE_TARGETS);
    return reply.status(201).send(rt.alerts.addRule(body));
  });
  app.delete('/v1/rules/:id', guard, async (req, reply) => (rt.alerts.deleteRule((req.params as any).id) ? reply.status(204).send() : reply.status(404).send({ error: 'not_found' })));
  app.get('/v1/alerts', guard, async () => ({ alerts: rt.alerts.active() }));
  app.get('/v1/alerts/events', guard, async (req) => ({ events: rt.alerts.events(Math.min(500, Number((req.query as any).limit) || 100)).filter((e) => e.to !== 'pending') }));

  // ------------------------------------------------------------------ monitores de uptime
  app.get('/v1/monitors', guard, async () => ({ monitors: rt.monitors.list() }));
  app.post('/v1/monitors', guard, async (req, reply) => reply.status(201).send(rt.monitors.add(req.body)));
  app.delete('/v1/monitors/:id', guard, async (req, reply) => (rt.monitors.remove((req.params as any).id) ? reply.status(204).send() : reply.status(404).send({ error: 'not_found' })));
  app.post('/v1/monitors/:id/check', guard, async (req, reply) => {
    const m = rt.monitors.list().find((x) => x.id === (req.params as any).id);
    return m ? rt.monitors.runCheck(m) : reply.status(404).send({ error: 'not_found' });
  });

  // ------------------------------------------------------------------ estado propio y demo
  app.get('/v1/stats', guard, async () => ({
    ingest: rt.ingestor.stats,
    storage: rt.store.counts(),
    metrics: rt.registry.metrics().length,
    limits: { maxSeriesPerMetric: cfg.MAX_SERIES_PER_METRIC, maxSeriesTotal: cfg.MAX_SERIES_TOTAL, maxPendingKeys: cfg.MAX_PENDING_KEYS },
    retention: { '10s': `${cfg.RETENTION_10S_HOURS}h`, '1m': `${cfg.RETENTION_1M_DAYS}d`, '1h': `${cfg.RETENTION_1H_DAYS}d` },
    simulate: cfg.SIMULATE ? { incident: rt.sim.incidentActive } : null,
  }));

  app.post('/v1/demo/incident', guard, async (req, reply) => {
    if (!cfg.SIMULATE) return reply.status(404).send({ error: 'not_found' });
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    rt.sim.setIncident(active);
    return { incident: active };
  });

  return app;
}
