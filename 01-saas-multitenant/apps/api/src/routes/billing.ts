import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, notFound } from '../errors.js';
import { parse, tenantRoute } from '../http.js';
import { PLANS } from '../domain/plans.js';
import { audit } from '../domain/audit.js';
import { priceToPlanMap } from '../billing/stripe.js';
import { processStripeEvent } from '../billing/webhook.js';
import { limitsPayload, usageOf } from './tenants.js';

const checkoutSchema = z.object({ plan: z.enum(['pro', 'business']) });

export async function billingRoutes(app: FastifyInstance) {
  const priceToPlan = priceToPlanMap(app.cfg);

  app.get(
    '/t/billing',
    tenantRoute(app, 'billing:read', async ({ q, tenant, role }) => ({
      provider: app.billing.kind,
      plan: tenant.plan,
      status: tenant.subscription_status,
      currentPeriodEnd: tenant.current_period_end,
      hasCustomer: Boolean(tenant.stripe_customer_id),
      canManage: role === 'owner',
      usage: await usageOf(q),
      limits: limitsPayload(tenant.plan),
      catalog: Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, priceUsd: p.priceUsd })),
    })),
  );

  app.post(
    '/t/billing/checkout',
    tenantRoute(app, 'billing:manage', async ({ req, tenant, tenantId }) => {
      const { plan } = parse(checkoutSchema, req.body);
      if (tenant.plan === plan) throw conflict(`Already on the ${plan} plan`);
      return app.billing.createCheckout({
        tenantId,
        plan,
        customerId: tenant.stripe_customer_id,
        successUrl: `${app.cfg.WEB_ORIGIN}/billing?status=success`,
        cancelUrl: `${app.cfg.WEB_ORIGIN}/billing?status=cancelled`,
      });
    }),
  );

  app.post(
    '/t/billing/portal',
    tenantRoute(app, 'billing:manage', async ({ tenant }) => {
      if (!tenant.stripe_customer_id) throw notFound('No billing account yet. Subscribe first.');
      return app.billing.createPortal({ customerId: tenant.stripe_customer_id, returnUrl: `${app.cfg.WEB_ORIGIN}/billing` });
    }),
  );

  // Solo con el proveedor "fake": inyecta un evento tipo Stripe por el mismo procesador que el webhook real.
  if (app.billing.kind === 'fake') {
    // Fase 1 (transacción del tenant): autenticar, autorizar, auditar y construir el evento.
    const buildEvent = tenantRoute(app, 'billing:manage', async ({ q, req, tenantId, userId, tenant }) => {
      const { action } = parse(z.object({ action: z.enum(['pro', 'business', 'cancel', 'payment_failed']) }), req.body);
      const customer = tenant.stripe_customer_id ?? `cus_sim_${tenantId.slice(0, 8)}`;
      const id = `evt_sim_${crypto.randomUUID()}`;
      await audit(q, { tenantId, actorId: userId, action: 'billing.simulated', entity: 'tenant', entityId: tenantId, meta: { action } });
      if (action === 'cancel') return { id, type: 'customer.subscription.deleted', data: { object: { customer } } };
      if (action === 'payment_failed') return { id, type: 'invoice.payment_failed', data: { object: { customer } } };
      return {
        id,
        type: 'checkout.session.completed',
        data: { object: { client_reference_id: tenantId, customer, subscription: `sub_sim_${tenantId.slice(0, 8)}`, metadata: { plan: action } } },
      };
    });
    // Fase 2 (transacción admin, ya fuera de la anterior): el mismo procesador idempotente del webhook real.
    app.post('/t/billing/simulate', async (req, reply) => {
      const event = await buildEvent(req, reply);
      return { event: event.type, ...(await processStripeEvent(app.db, event, priceToPlan)) };
    });
  }
}
