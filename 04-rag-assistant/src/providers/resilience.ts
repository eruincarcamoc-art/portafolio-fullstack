import { ProviderError } from './types.js';

export interface RetryOptions {
  retries: number;
  baseMs: number;
  capMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rng?: () => number;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });

/**
 * Reintenta fallos transitorios (429, 5xx, red) con backoff exponencial + jitter y respeta `Retry-After`.
 * Los errores 4xx "de verdad" (clave inválida, petición mal formada) NO se reintentan.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions, signal?: AbortSignal): Promise<T> {
  const wait = opts.sleep ?? sleep;
  const rng = opts.rng ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = err instanceof ProviderError ? err.retryable : !(signal?.aborted);
      if (!retryable || attempt >= opts.retries || signal?.aborted) throw err;
      const exp = Math.min(opts.capMs, opts.baseMs * 2 ** attempt);
      const retryAfter = err instanceof ProviderError && (err as any).retryAfterMs ? (err as any).retryAfterMs : 0;
      await wait(Math.max(retryAfter, Math.round(exp / 2 + (rng() * exp) / 2)), signal);
    }
  }
}

/**
 * Cortacircuitos: tras N fallos seguidos "abre" y falla rápido durante `cooldownMs`, en vez de acumular
 * peticiones colgadas contra un proveedor caído. Pasado el enfriamiento deja pasar UNA prueba (half-open).
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.failures < this.threshold) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const s = this.state;
    if (s === 'open' || (s === 'half-open' && this.probing)) {
      throw new ProviderError('Upstream provider unavailable (circuit open)', 503, false);
    }
    if (s === 'half-open') this.probing = true;
    try {
      const out = await fn();
      this.failures = 0;
      return out;
    } catch (err) {
      // Solo cuentan los fallos del proveedor, no los errores del usuario ni las cancelaciones.
      if (err instanceof ProviderError && err.status !== null && err.status < 500 && err.status !== 429) throw err;
      this.failures++;
      if (this.failures >= this.threshold) this.openedAt = this.now();
      throw err;
    } finally {
      this.probing = false;
    }
  }
}
