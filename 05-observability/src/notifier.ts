import type { Notification, Notifier } from './alerts.js';
import { createSafeFetch, type SafeFetch } from './net.js';

export interface WebhookOptions {
  fetchImpl?: SafeFetch;
  allowPrivate?: boolean;
  retries?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, extra?: object) => void;
}

/**
 * Entrega por webhook con reintentos (backoff exponencial), timeout y protección SSRF.
 * Los errores de URL insegura NO se reintentan (reintentar no los arregla).
 */
export class WebhookNotifier implements Notifier {
  private readonly fetchImpl: SafeFetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: WebhookOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? createSafeFetch(opts.allowPrivate ?? false);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async send(n: Notification): Promise<'delivered' | 'failed' | 'none'> {
    const url = n.rule.webhook;
    if (!url) return 'none';
    const body = JSON.stringify({
      status: n.state === 'resolved' ? 'resolved' : 'firing',
      repeat: n.state === 'repeat',
      rule: n.rule.name,
      severity: n.rule.severity,
      metric: n.rule.metric,
      condition: `${n.rule.agg}(${n.rule.metric}) ${n.rule.op} ${n.rule.threshold} over ${n.rule.windowSec}s`,
      labels: n.labels,
      value: n.value,
      at: new Date(n.at).toISOString(),
    });
    const retries = this.opts.retries ?? 3;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'pulse-alerts/1.0' }, body, timeoutMs: 5000 });
        if (res.status >= 200 && res.status < 300) return 'delivered';
        if (res.status < 500 && res.status !== 429) break; // 4xx: el destino rechaza el mensaje, reintentar no ayuda
      } catch (e) {
        this.opts.log?.('webhook error', { error: String(e) });
        if ((e as Error).name === 'UnsafeTargetError' || /blocked/.test(String((e as Error).message) + String((e as any).cause?.message))) break;
      }
      if (attempt < retries) await this.sleep((this.opts.baseMs ?? 500) * 2 ** attempt);
    }
    return 'failed';
  }
}

/** Notificador de pruebas: guarda en memoria lo que se enviaría. */
export class MemoryNotifier implements Notifier {
  sent: Notification[] = [];
  async send(n: Notification) {
    this.sent.push(n);
    return 'delivered' as const;
  }
}
