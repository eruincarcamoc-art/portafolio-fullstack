import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db, Queryable } from '../db/types.js';
import type { Plan } from '../domain/plans.js';

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: any };
}

/**
 * Verifica la cabecera `Stripe-Signature` (esquema v1: HMAC-SHA256 de `${t}.${payload}`).
 * - Comparación en tiempo constante.
 * - Tolerancia de 5 min contra replays.
 * - Soporta varias firmas v1 (rotación de secretos).
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  opts: { toleranceSec?: number; now?: number } = {},
): boolean {
  if (!header) return false;
  const tolerance = opts.toleranceSec ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't' && v) timestamp = Number(v);
    if (k === 'v1' && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Helper para tests / simulación: genera una cabecera válida. */
export function signStripePayload(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

type PriceToPlan = (priceId: string | undefined) => Plan | null;

const periodEnd = (sub: any): Date | null => {
  const ts = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
};

async function applyEvent(q: Queryable, event: StripeEvent, priceToPlan: PriceToPlan): Promise<void> {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const tenantId: string | undefined = obj.client_reference_id;
      const plan = (obj.metadata?.plan as Plan | undefined) ?? 'pro';
      if (!tenantId) return;
      await q.query(
        `UPDATE tenants SET plan=$2, subscription_status='active', stripe_customer_id=$3, stripe_subscription_id=$4 WHERE id=$1`,
        [tenantId, plan, obj.customer, obj.subscription],
      );
      await q.query(
        `INSERT INTO audit_log(tenant_id, action, entity, entity_id, meta) VALUES ($1,'billing.subscribed','tenant',$2,$3)`,
        [tenantId, tenantId, JSON.stringify({ plan, event: event.id })],
      );
      return;
    }
    case 'customer.subscription.updated': {
      const plan = priceToPlan(obj.items?.data?.[0]?.price?.id);
      const active = obj.status === 'active' || obj.status === 'trialing';
      await q.query(
        `UPDATE tenants
            SET subscription_status=$2,
                stripe_subscription_id=$3,
                current_period_end=$4,
                plan = CASE WHEN $5::text IS NOT NULL AND $6::boolean THEN $5::text ELSE plan END
          WHERE stripe_customer_id=$1`,
        [obj.customer, obj.status, obj.id, periodEnd(obj), plan, active],
      );
      return;
    }
    case 'customer.subscription.deleted': {
      await q.query(
        `UPDATE tenants SET plan='free', subscription_status='canceled', stripe_subscription_id=NULL WHERE stripe_customer_id=$1`,
        [obj.customer],
      );
      return;
    }
    case 'invoice.payment_failed': {
      await q.query(`UPDATE tenants SET subscription_status='past_due' WHERE stripe_customer_id=$1`, [obj.customer]);
      return;
    }
    default:
      return; // eventos que no nos interesan: se registran y se ignoran
  }
}

/**
 * Procesa un evento exactamente una vez. El INSERT en stripe_events y el efecto
 * van en la misma transacción: si el efecto falla, el evento NO queda marcado y
 * Stripe reintenta; si llega duplicado, ON CONFLICT lo descarta.
 */
export async function processStripeEvent(
  db: Db,
  event: StripeEvent,
  priceToPlan: PriceToPlan,
): Promise<{ duplicate: boolean }> {
  return db.admin(async (q) => {
    const inserted = await q.query(
      `INSERT INTO stripe_events(id, type) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [event.id, event.type],
    );
    if (inserted.length === 0) return { duplicate: true };
    await applyEvent(q, event, priceToPlan);
    return { duplicate: false };
  });
}
