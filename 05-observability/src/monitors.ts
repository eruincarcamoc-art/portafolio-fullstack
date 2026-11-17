import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Ingestor } from './ingest.js';
import { assertSafeUrlShape, type SafeFetch } from './net.js';
import type { Store } from './store.js';

export const monitorSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
  url: z.string().url().max(500),
  intervalSec: z.number().int().min(10).max(3600).default(30),
  timeoutMs: z.number().int().min(200).max(30_000).default(5000),
  /** Estado HTTP exacto esperado; por defecto cualquier 2xx/3xx. */
  expectStatus: z.number().int().min(100).max(599).optional(),
});
export type MonitorSpec = z.infer<typeof monitorSchema>;
export interface Monitor extends MonitorSpec {
  id: string;
}

export interface CheckResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
  at: number;
}

/**
 * Comprobaciones sintéticas de disponibilidad. Los resultados NO viven aparte: se ingieren como métricas normales
 * (`uptime_check_success` 0/1 y `uptime_check_duration_ms`), así que se consultan, se grafican y se alertan con el
 * mismo motor que todo lo demás ("dogfooding").
 */
export class MonitorRunner {
  private monitors = new Map<string, Monitor>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private last = new Map<string, CheckResult>();

  constructor(
    private readonly store: Store,
    private readonly ingestor: Ingestor,
    private readonly fetchImpl: SafeFetch,
    private readonly opts: { allowPrivate: boolean; now?: () => number } = { allowPrivate: false },
  ) {
    for (const r of store.db.prepare(`SELECT id, spec FROM monitors`).all() as any[]) this.monitors.set(r.id, { id: r.id, ...JSON.parse(r.spec) });
  }

  private now = () => (this.opts.now ?? Date.now)();

  add(input: unknown): Monitor {
    const spec = monitorSchema.parse(input);
    assertSafeUrlShape(spec.url, this.opts.allowPrivate);
    const m: Monitor = { id: randomBytes(4).toString('hex'), ...spec };
    this.store.db.prepare(`INSERT INTO monitors(id, spec, created_at) VALUES (?,?,?)`).run(m.id, JSON.stringify(spec), this.now());
    this.monitors.set(m.id, m);
    if (this.timers.size > 0 || this.started) this.schedule(m);
    return m;
  }

  remove(id: string): boolean {
    if (!this.monitors.delete(id)) return false;
    this.store.db.prepare(`DELETE FROM monitors WHERE id=?`).run(id);
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
    this.last.delete(id);
    return true;
  }

  list(): Array<Monitor & { last: CheckResult | null }> {
    return [...this.monitors.values()].map((m) => ({ ...m, last: this.last.get(m.id) ?? null }));
  }

  async runCheck(m: Monitor): Promise<CheckResult> {
    const started = performance.now();
    let result: CheckResult;
    try {
      const res = await this.fetchImpl(m.url, { method: 'GET', timeoutMs: m.timeoutMs, headers: { 'user-agent': 'pulse-uptime/1.0' } });
      const ok = m.expectStatus ? res.status === m.expectStatus : res.status >= 200 && res.status < 400;
      result = { ok, status: res.status, latencyMs: Math.round(performance.now() - started), error: ok ? null : `unexpected status ${res.status}`, at: this.now() };
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? 'timeout' : String((e as any)?.cause?.message ?? (e as Error).message);
      result = { ok: false, status: null, latencyMs: Math.round(performance.now() - started), error: msg.slice(0, 200), at: this.now() };
    }
    this.last.set(m.id, result);
    const labels = { monitor: m.name };
    this.ingestor.ingest([
      { name: 'uptime_check_success', type: 'gauge', labels, value: result.ok ? 1 : 0, ts: result.at },
      { name: 'uptime_check_duration_ms', type: 'timer', labels, value: result.latencyMs, ts: result.at },
    ]);
    return result;
  }

  private started = false;

  start(): void {
    this.started = true;
    for (const m of this.monitors.values()) this.schedule(m);
  }

  private schedule(m: Monitor): void {
    if (this.timers.has(m.id)) return;
    // jitter inicial: no lanzar todos los monitores en el mismo instante
    const first = setTimeout(() => void this.runCheck(m), Math.random() * 2000);
    first.unref?.();
    const t = setInterval(() => void this.runCheck(m), m.intervalSec * 1000);
    t.unref?.();
    this.timers.set(m.id, t);
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}
