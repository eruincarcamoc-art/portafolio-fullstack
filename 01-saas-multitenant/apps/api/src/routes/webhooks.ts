import type { FastifyInstance } from 'fastify';
import { AppError, badRequest } from '../errors.js';
import { priceToPlanMap } from '../billing/stripe.js';
import { processStripeEvent, verifyStripeSignature, type StripeEvent } from '../billing/webhook.js';

export async function webhookRoutes(app: FastifyInstance) {
  // Plugin encapsulado: aquí el body JSON se conserva como Buffer crudo,
  // porque la firma se calcula sobre los bytes exactos que envió Stripe.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    const priceToPlan = priceToPlanMap(app.cfg);

    scope.post('/webhooks/stripe', { config: { rateLimit: false } }, async (req, reply) => {
      const secret = app.cfg.STRIPE_WEBHOOK_SECRET;
      if (!secret) throw new AppError(503, 'webhook_disabled', 'Stripe webhook secret is not configured');

      const raw = req.body as Buffer;
      const signature = req.headers['stripe-signature'];
      if (!verifyStripeSignature(raw, Array.isArray(signature) ? signature[0] : signature, secret)) {
        throw badRequest('Invalid signature');
      }

      let event: StripeEvent;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        throw badRequest('Invalid JSON');
      }
      if (!event?.id || !event?.type) throw badRequest('Malformed event');

      const result = await processStripeEvent(app.db, event, priceToPlan);
      // 200 también para duplicados: Stripe deja de reintentar.
      return reply.status(200).send({ received: true, duplicate: result.duplicate });
    });
  });
}
