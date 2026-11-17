import type { IncomingPoint, Ingestor } from './ingest.js';

/**
 * Simulador de tráfico para la demo: tres servicios con carga, latencias log-normales, errores y CPU.
 * `setIncident(true)` provoca un incidente (más errores 5xx y latencia ×5) para ver cómo saltan las alertas.
 */
const SERVICES: Array<{ name: string; routes: Array<{ route: string; rps: number; medianMs: number }> }> = [
  { name: 'api', routes: [{ route: '/users', rps: 25, medianMs: 40 }, { route: '/orders', rps: 15, medianMs: 70 }] },
  { name: 'checkout', routes: [{ route: '/pay', rps: 6, medianMs: 180 }, { route: '/cart', rps: 12, medianMs: 55 }] },
  { name: 'search', routes: [{ route: '/query', rps: 30, medianMs: 90 }] },
];

const normal = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-12)) * Math.cos(2 * Math.PI * Math.random());

export class TrafficSimulator {
  private incident = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ingestor: Ingestor,
    private readonly now: () => number = Date.now,
  ) {}

  get incidentActive(): boolean {
    return this.incident;
  }

  setIncident(on: boolean): void {
    this.incident = on;
  }

  /** Genera un "tick" de `seconds` segundos terminando en `ts`. */
  tick(ts: number, seconds = 1, incident = this.incident): number {
    const pts: IncomingPoint[] = [];
    const wave = 1 + 0.25 * Math.sin(ts / 60_000); // carga ondulante
    for (const svc of SERVICES) {
      for (const r of svc.routes) {
        const n = Math.max(0, Math.round(r.rps * seconds * wave * (0.85 + 0.3 * Math.random())));
        const errRate = incident && svc.name !== 'search' ? 0.3 : 0.004;
        const err = Math.round(n * errRate);
        const labels = { service: svc.name, route: r.route };
        pts.push({ name: 'http_requests_total', type: 'counter', labels: { ...labels, status: '2xx' }, value: n - err, ts });
        if (err) pts.push({ name: 'http_requests_total', type: 'counter', labels: { ...labels, status: '5xx' }, value: err, ts });
        const factor = incident && svc.name !== 'search' ? 5 : 1;
        for (let i = 0; i < Math.min(n, 12); i++) {
          pts.push({ name: 'http_request_duration_ms', type: 'timer', labels, value: r.medianMs * factor * Math.exp(0.45 * normal()), ts: ts - Math.floor(Math.random() * seconds * 1000) });
        }
      }
    }
    for (const host of ['web-1', 'web-2']) {
      pts.push({ name: 'cpu_usage_percent', type: 'gauge', labels: { host }, value: Math.min(100, Math.max(1, 35 + 15 * Math.sin(ts / 90_000) + (incident ? 35 : 0) + 4 * normal())), ts });
    }
    pts.push({ name: 'queue_depth', type: 'gauge', labels: { queue: 'emails' }, value: Math.max(0, Math.round(20 + 10 * Math.sin(ts / 45_000) + (incident ? 150 : 0) + 3 * normal())), ts });
    return this.ingestor.ingest(pts).accepted;
  }

  /** Rellena historial para que los gráficos no empiecen vacíos. */
  backfill(minutes: number, stepSec = 10): void {
    const end = this.now();
    for (let t = end - minutes * 60_000; t < end; t += stepSec * 1000) this.tick(t, stepSec, false);
    this.ingestor.flush();
  }

  start(): void {
    this.timer = setInterval(() => this.tick(this.now()), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
