import type { Plan } from '../domain/plans.js';

export interface CheckoutInput {
  tenantId: string;
  plan: Exclude<Plan, 'free'>;
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingProvider {
  /** 'fake' permite probar el flujo completo sin cuenta de Stripe. */
  kind: 'stripe' | 'fake';
  createCheckout(input: CheckoutInput): Promise<{ url: string }>;
  createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}
