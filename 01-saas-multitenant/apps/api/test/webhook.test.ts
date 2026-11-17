import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, makeApp, register, type TestCtx } from './helpers.js';
import { signStripePayload, verifyStripeSignature } from '../src/billing/webhook.js';

const SECRET = 'whsec_test_secret';
let t: TestCtx;

beforeAll(async () => {
  t = await makeApp({ STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_BUSINESS: 'price_biz' });
});
afterAll(() => t.close());

const post = (payload: string, signature?: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/webhooks/stripe',
    headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
    payload,
  });

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1"}';
  it('accepts a valid signature', () => {
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET), SECRET)).toBe(true);
  });
  it('rejects tampered body, wrong secret, missing header and old timestamps', () => {
    const sig = signStripePayload(body, SECRET);
    expect(verifyStripeSignature('{"id":"evt_2"}', sig, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, sig, 'other')).toBe(false);
    expect(verifyStripeSignature(body, undefined, SECRET)).toBe(false);
    const old = signStripePayload(body, SECRET, Math.floor(Date.now() / 1000) - 3600);
    expect(verifyStripeSignature(body, old, SECRET)).toBe(false);
  });
  it('accepts any of several v1 signatures (secret rotation)', () => {
    const t0 = Math.floor(Date.now() / 1000);
    const good = signStripePayload(body, SECRET, t0).split('v1=')[1];
    expect(verifyStripeSignature(body, `t=${t0},v1=${'0'.repeat(64)},v1=${good}`, SECRET)).toBe(true);
  });
});

describe('POST /api/webhooks/stripe', () => {
  it('rejects unsigned or badly signed requests', async () => {
    expect((await post('{"id":"x","type":"y"}')).statusCode).toBe(400);
    expect((await post('{"id":"x","type":"y"}', signStripePayload('{"id":"x","type":"y"}', 'wrong'))).statusCode).toBe(400);
  });

  it('applies the lifecycle and is idempotent on retries', async () => {
    const o = await register(t.app, 'Hook');
    const api = call(t.app, o, o.tenantId);

    const checkout = JSON.stringify({
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: o.tenantId, customer: 'cus_123', subscription: 'sub_123', metadata: { plan: 'pro' } } },
    });
    const first = await post(checkout, signStripePayload(checkout, SECRET));
    expect(first.json()).toEqual({ received: true, duplicate: false });
    expect((await api('GET', '/t')).json().tenant.plan).toBe('pro');

    // Stripe reintenta el mismo evento: 200 pero sin reprocesar.
    const retry = await post(checkout, signStripePayload(checkout, SECRET));
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate).toBe(true);
    const audits = (await api('GET', '/t/audit')).json().items.filter((i: any) => i.action === 'billing.subscribed');
    expect(audits).toHaveLength(1);

    // Upgrade a business vía subscription.updated (mapea price -> plan)
    const updated = JSON.stringify({
      id: 'evt_upd_1',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_123', customer: 'cus_123', status: 'active', current_period_end: 1893456000, items: { data: [{ price: { id: 'price_biz' } }] } } },
    });
    await post(updated, signStripePayload(updated, SECRET));
    const billing = (await api('GET', '/t/billing')).json();
    expect(billing.plan).toBe('business');
    expect(billing.currentPeriodEnd).toBeTruthy();

    // Cancelación
    const del = JSON.stringify({ id: 'evt_del_1', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_123' } } });
    await post(del, signStripePayload(del, SECRET));
    expect((await api('GET', '/t')).json().tenant.plan).toBe('free');
  });

  it('ignores unknown event types but records them', async () => {
    const e = JSON.stringify({ id: 'evt_other', type: 'charge.refunded', data: { object: {} } });
    expect((await post(e, signStripePayload(e, SECRET))).statusCode).toBe(200);
    const rows = await t.db.admin((q) => q.query(`SELECT id FROM stripe_events WHERE id='evt_other'`));
    expect(rows).toHaveLength(1);
  });
});
