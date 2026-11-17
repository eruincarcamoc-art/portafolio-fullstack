import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/types.js';
import { AppError } from './errors.js';
import type { BillingProvider } from './billing/provider.js';
import { createFakeProvider } from './billing/fake.js';
import { createStripeProvider } from './billing/stripe.js';
import { authRoutes } from './routes/auth.js';
import { tenantRoutes } from './routes/tenants.js';
import { projectRoutes } from './routes/projects.js';
import { memberRoutes } from './routes/members.js';
import { billingRoutes } from './routes/billing.js';
import { webhookRoutes } from './routes/webhooks.js';
import { auditRoutes } from './routes/audit.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    cfg: Config;
    billing: BillingProvider;
  }
}

export interface BuildOptions {
  config: Config;
  db: Db;
  billing?: BillingProvider;
  /** Desactivar en tests para no chocar con el límite de peticiones. */
  rateLimit?: boolean;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? config.NODE_ENV !== 'test',
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.decorate('db', opts.db);
  app.decorate('cfg', config);
  app.decorate(
    'billing',
    opts.billing ?? (config.STRIPE_SECRET_KEY ? createStripeProvider(config) : createFakeProvider(config.WEB_ORIGIN)),
  );

  await app.register(helmet);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(jwt, { secret: config.JWT_SECRET, sign: { expiresIn: '15m' } });
  if (opts.rateLimit !== false) {
    await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'bad_request', message: 'Validation failed', details: err.issues } });
    }
    const status = (err as any).statusCode as number | undefined;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } }));

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(tenantRoutes);
      await api.register(projectRoutes);
      await api.register(memberRoutes);
      await api.register(auditRoutes);
      await api.register(billingRoutes);
      await api.register(webhookRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
