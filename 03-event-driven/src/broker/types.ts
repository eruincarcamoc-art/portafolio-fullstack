import type { Queryable } from '../db/index.js';

export interface Message {
  id: string;
  topic: string;
  key: string;
  payload: any;
}

export interface Delivery {
  id: number;
  consumer: string;
  messageId: string;
  key: string;
  /** Nº de intento (1 = primera vez). Se incrementa al reclamar, así un crash también cuenta. */
  attempts: number;
  message: Message;
}

export interface HandlerCtx {
  /** Transacción del handler: efectos, bandeja de entrada y `emit` se confirman (o revierten) juntos. */
  q: Queryable;
  msg: Message;
  attempt: number;
  now: Date;
  /** Escribe un evento en el outbox, dentro de la misma transacción. */
  emit(topic: string, payload: Record<string, unknown>, key?: string): Promise<void>;
}

export interface ConsumerDef {
  name: string;
  topics: string[];
  handler(ctx: HandlerCtx): Promise<void>;
  maxAttempts?: number;
}

/** Error que no merece reintento (mensaje venenoso, regla de negocio): va directo a la DLQ. */
export class PermanentError extends Error {
  readonly permanent = true;
}

/** Fallo transitorio esperado (red, timeout, 503): se reintenta con backoff. */
export class TransientError extends Error {
  readonly permanent = false;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseMs: 1000, capMs: 60_000 };

/**
 * Backoff exponencial con "equal jitter": mitad fija + mitad aleatoria.
 * El jitter evita el "thundering herd" (todos los reintentos a la vez); la mitad fija garantiza que nunca sea 0.
 */
export function backoffMs(attempt: number, policy: RetryPolicy, rng: () => number = Math.random): number {
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + (rng() * exp) / 2);
}
