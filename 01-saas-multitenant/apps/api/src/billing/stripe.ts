import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { Plan } from '../domain/plans.js';
import type { BillingProvider, CheckoutInput } from './provider.js';

/** Cliente mínimo de Stripe sobre fetch (sin SDK): menos superficie y fácil de mockear. */
export function createStripeProvider(cfg: Config, fetchImpl: typeof fetch = fetch): BillingProvider {
  const key = cfg.STRIPE_SECRET_KEY!;
  const prices: Record<string, string | undefined> = {
    pro: cfg.STRIPE_PRICE_PRO,
    business: cfg.STRIPE_PRICE_BUSINESS,
  };

  async function post(path: string, body: Record<string, string>, idempotencyKey?: string) {
    const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: new URLSearchParams(body),
    });
    const json: any = await res.json();
    if (!res.ok) throw new AppError(502, 'billing_provider_error', json?.error?.message ?? 'Stripe error');
    return json;
  }

  return {
    kind: 'stripe',
    async createCheckout(i: CheckoutInput) {
      const price = prices[i.plan];
      if (!price) throw new AppError(500, 'billing_misconfigured', `Missing Stripe price for plan ${i.plan}`);
      const body: Record<string, string> = {
        mode: 'subscription',
        'line_items[0][price]': price,
        'line_items[0][quantity]': '1',
        client_reference_id: i.tenantId,
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
        'metadata[plan]': i.plan,
        'subscription_data[metadata][tenant_id]': i.tenantId,
      };
      if (i.customerId) body.customer = i.customerId;
      const session = await post('checkout/sessions', body);
      return { url: session.url as string };
    },
    async createPortal({ customerId, returnUrl }) {
      const session = await post('billing_portal/sessions', { customer: customerId, return_url: returnUrl });
      return { url: session.url as string };
    },
  };
}

export const priceToPlanMap =
  (cfg: Pick<Config, 'STRIPE_PRICE_PRO' | 'STRIPE_PRICE_BUSINESS'>) =>
  (priceId: string | undefined): Plan | null => {
    if (!priceId) return null;
    if (priceId === cfg.STRIPE_PRICE_PRO) return 'pro';
    if (priceId === cfg.STRIPE_PRICE_BUSINESS) return 'business';
    return null;
  };
