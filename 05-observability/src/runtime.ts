import type { Config } from './config.js';
import { AlertEngine, type Notifier } from './alerts.js';
import { Ingestor } from './ingest.js';
import { MonitorRunner } from './monitors.js';
import { createSafeFetch, type SafeFetch } from './net.js';
import { WebhookNotifier } from './notifier.js';
import { SeriesRegistry } from './series.js';
import { TrafficSimulator } from './sim.js';
import { Store } from './store.js';

export interface Runtime {
  cfg: Config;
  store: Store;
  registry: SeriesRegistry;
  ingestor: Ingestor;
  alerts: AlertEngine;
  monitors: MonitorRunner;
  sim: TrafficSimulator;
  now: () => number;
  /** Arranca los bucles periódicos (flush, rollups, retención, evaluación de alertas, monitores, métricas propias). */
  start(): void;
  stop(): Promise<void>;
  /** Un ciclo de mantenimiento, invocable a mano (tests). */
  maintenance(): { rolled: ReturnType<Store['rollup']>; retention: ReturnType<Store['applyRetention']> };
}

export interface RuntimeOptions {
  now?: () => number;
  notifier?: Notifier;
  safeFetch?: SafeFetch;
  log?: (msg: string, extra?: object) => void;
}

export function createRuntime(cfg: Config, opts: RuntimeOptions = {}): Runtime {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const store = new Store(cfg.DB_PATH, cfg);
  const registry = new SeriesRegistry(cfg.MAX_SERIES_PER_METRIC, cfg.MAX_SERIES_TOTAL);
  registry.load(store.loadSeries());
  const ingestor = new Ingestor(store, registry, cfg, now);
  const safeFetch = opts.safeFetch ?? createSafeFetch(cfg.ALLOW_PRIVATE_TARGETS);
  const notifier = opts.notifier ?? new WebhookNotifier({ fetchImpl: safeFetch, log });
  const alerts = new AlertEngine(store, registry, notifier, now);
  const monitors = new MonitorRunner(store, ingestor, safeFetch, { allowPrivate: cfg.ALLOW_PRIVATE_TARGETS, now });
  const sim = new TrafficSimulator(ingestor, now);

  const timers: Array<ReturnType<typeof setInterval>> = [];
  let last = { accepted: 0, invalid: 0, cardinality: 0, shed: 0 };

  /** La plataforma se monitoriza a sí misma con su propio pipeline. */
  const selfMetrics = () => {
    const s = ingestor.stats;
    const d = { accepted: s.accepted - last.accepted, invalid: s.rejectedInvalid - last.invalid, cardinality: s.rejectedCardinality - last.cardinality, shed: s.rejectedShed - last.shed };
    last = { accepted: s.accepted, invalid: s.rejectedInvalid, cardinality: s.rejectedCardinality, shed: s.rejectedShed };
    const t = now();
    try {
      ingestor.ingest([
        { name: 'pulse_points_accepted_total', type: 'counter', value: d.accepted, ts: t },
        { name: 'pulse_points_rejected_total', type: 'counter', labels: { reason: 'invalid' }, value: d.invalid, ts: t },
        { name: 'pulse_points_rejected_total', type: 'counter', labels: { reason: 'cardinality' }, value: d.cardinality, ts: t },
        { name: 'pulse_points_rejected_total', type: 'counter', labels: { reason: 'overload' }, value: d.shed, ts: t },
        { name: 'pulse_pending_keys', type: 'gauge', value: s.pendingKeys, ts: t },
        { name: 'pulse_flush_ms', type: 'gauge', value: s.lastFlushMs, ts: t },
        { name: 'pulse_series', type: 'gauge', value: registry.size, ts: t },
      ]);
    } catch { /* si está saturada, no se agrava la situación con métricas propias */ }
  };

  const maintenance = () => {
    ingestor.flush();
    const rolled = store.rollup(now());
    const retention = store.applyRetention(now());
    for (const id of retention.seriesRemoved) registry.forget(id);
    return { rolled, retention };
  };

  return {
    cfg, store, registry, ingestor, alerts, monitors, sim, now, maintenance,
    start() {
      const every = (ms: number, fn: () => void | Promise<void>, name: string) => {
        const t = setInterval(() => void Promise.resolve(fn()).catch((e) => log(`${name} failed`, { error: String(e) })), ms);
        t.unref?.();
        timers.push(t);
      };
      every(10_000, () => { ingestor.flush(); store.rollup(now()); }, 'rollup');
      every(3_600_000, () => { const r = store.applyRetention(now()); for (const id of r.seriesRemoved) registry.forget(id); log('retention applied', r.deleted); }, 'retention');
      every(cfg.EVAL_INTERVAL_SECONDS * 1000, () => alerts.evaluate(), 'alerts');
      every(10_000, selfMetrics, 'self-metrics');
      monitors.start();
      if (cfg.SIMULATE) sim.start();
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      sim.stop();
      monitors.stop();
      ingestor.close();
      store.close();
    },
  };
}
