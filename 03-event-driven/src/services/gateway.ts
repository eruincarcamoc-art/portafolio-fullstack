import { PermanentError, TransientError } from '../broker/types.js';

/** Interruptores para provocar fallos en vivo (demo del dashboard y tests de caos). */
export interface Chaos {
  /** Probabilidad (0-1) de que la pasarela de pago falle con un error transitorio. */
  paymentTransientRate: number;
  /** Importes mayores que esto son rechazados (tarjeta declinada = error permanente). */
  paymentDeclineAboveCents: number | null;
  /** Probabilidad de fallo del proveedor de email. */
  mailerFailRate: number;
  /** Simula un despliegue con un bug en el servicio de inventario. */
  inventoryBug: boolean;
}

export const defaultChaos = (): Chaos => ({
  paymentTransientRate: 0,
  paymentDeclineAboveCents: null,
  mailerFailRate: 0,
  inventoryBug: false,
});

export interface PaymentGateway {
  charge(input: { orderId: string; amountCents: number }): Promise<{ ref: string }>;
}

/**
 * Pasarela simulada. Como las reales (Stripe, Adyen), es IDEMPOTENTE por clave: cobrar dos veces el mismo
 * pedido no genera dos cobros. Eso es lo que hace seguro reintentar tras un timeout ambiguo.
 */
export class FakeGateway implements PaymentGateway {
  private readonly charges = new Map<string, string>();
  attempts = 0;

  constructor(
    private readonly chaos: Chaos,
    private readonly rng: () => number = Math.random,
  ) {}

  /** Cobros realmente creados (para verificar que no hay doble cobro). */
  get chargesCreated(): number {
    return this.charges.size;
  }

  async charge({ orderId, amountCents }: { orderId: string; amountCents: number }) {
    this.attempts++;
    const existing = this.charges.get(orderId);
    if (existing) return { ref: existing };
    if (this.chaos.paymentDeclineAboveCents !== null && amountCents > this.chaos.paymentDeclineAboveCents) {
      throw new PermanentError(`card_declined: amount ${amountCents} exceeds limit`);
    }
    if (this.rng() < this.chaos.paymentTransientRate) throw new TransientError('gateway timeout');
    const ref = `ch_${orderId.slice(0, 8)}`;
    this.charges.set(orderId, ref);
    return { ref };
  }
}

export interface Mailer {
  send(to: string, subject: string): Promise<void>;
}

export class FakeMailer implements Mailer {
  readonly sent: Array<{ to: string; subject: string }> = [];
  constructor(
    private readonly chaos: Chaos,
    private readonly rng: () => number = Math.random,
  ) {}
  async send(to: string, subject: string) {
    if (this.rng() < this.chaos.mailerFailRate) throw new TransientError('smtp 503');
    this.sent.push({ to, subject });
  }
}
