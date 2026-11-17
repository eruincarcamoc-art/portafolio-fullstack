import { buildApi } from './api.js';
import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

const cfg = loadConfig();
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const rt = createRuntime(cfg, { log });
rt.store.rollup(rt.now()); // recupera cualquier rollup pendiente de una ejecución anterior

if (cfg.SIMULATE) {
  rt.sim.backfill(60);
  // Reglas de demostración (solo si no existen ya: persisten entre arranques).
  if (rt.alerts.listRules().length === 0) {
    rt.alerts.addRule({ name: 'p99 latency high', metric: 'http_request_duration_ms', agg: 'p99', windowSec: 30, op: '>', threshold: 800, forSec: 20, groupBy: ['service'], severity: 'critical' });
    rt.alerts.addRule({ name: 'Elevated 5xx rate', metric: 'http_requests_total', agg: 'rate', windowSec: 30, op: '>', threshold: 2, forSec: 20, groupBy: ['service'], filters: { status: '5xx' }, severity: 'critical' });
    rt.alerts.addRule({ name: 'Queue backlog', metric: 'queue_depth', agg: 'avg', windowSec: 30, op: '>', threshold: 100, forSec: 20, severity: 'warning' });
  }
  log('simulation enabled: 60 min of synthetic history loaded');
}

rt.start();
const app = await buildApi(rt);
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
log('started', { port: cfg.PORT, db: cfg.DB_PATH, auth: Boolean(cfg.API_KEY), simulate: cfg.SIMULATE });

const shutdown = async (sig: string) => {
  log('shutting down', { sig });
  await app.close();
  await rt.stop(); // vuelca lo pendiente en memoria antes de cerrar
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
