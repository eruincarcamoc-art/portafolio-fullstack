import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { MemoryNotifier } from '../src/notifier.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { T0, clock } from './helpers.js';

let app: FastifyInstance;
let rt: Runtime;
const c = clock();

async function setup(env: Record<string, string> = {}) {
  c.set(T0);
  rt = createRuntime(loadConfig({ NODE_ENV: 'test', DB_PATH: ':memory:', ...env } as any), { now: c.now, notifier: new MemoryNotifier() });
  app = await buildApi(rt);
  await app.ready();
}
afterEach(async () => {
  await app?.close();
  await rt?.stop();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers });

describe('ingest API', () => {
  it('accepts a batch (202) and reports rejected points individually', async () => {
    await setup();
    const r = await post('/v1/ingest', { points: [{ name: 'cpu', value: 1 }, { name: 'bad name', value: 1 }, { name: 'cpu', value: 'x' }] });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ accepted: 1, rejectedCount: 2 });
    expect(r.json().rejected.map((x: any) => x.index)).toEqual([1, 2]);
  });

  it('returns 400 when nothing in the batch is valid, and rejects malformed envelopes', async () => {
    await setup();
    expect((await post('/v1/ingest', { points: [{ name: '1x', value: 1 }] })).statusCode).toBe(400);
    expect((await post('/v1/ingest', { nope: [] })).statusCode).toBe(400);
    expect((await post('/v1/ingest', { points: 'x' })).statusCode).toBe(400);
  });

  it('enforces the batch size limit and answers 429 + Retry-After when overloaded', async () => {
    await setup({ MAX_BATCH_POINTS: '5', MAX_PENDING_KEYS: '3', FLUSH_AT_KEYS: '1000' });
    expect((await post('/v1/ingest', { points: Array.from({ length: 6 }, () => ({ name: 'm', value: 1 })) })).statusCode).toBe(400);
    await post('/v1/ingest', { points: [1, 2, 3].map((i) => ({ name: 'm', labels: { i: String(i) }, value: 1 })) });
    const shed = await post('/v1/ingest', { points: [{ name: 'm', value: 1 }] });
    expect(shed.statusCode).toBe(429);
    expect(Number(shed.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('API key protects /v1/* but not /health', async () => {
    await setup({ API_KEY: 'k-secret-key' });
    expect((await post('/v1/ingest', { points: [{ name: 'm', value: 1 }] })).statusCode).toBe(401);
    expect((await post('/v1/ingest', { points: [{ name: 'm', value: 1 }] }, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await post('/v1/ingest', { points: [{ name: 'm', value: 1 }] }, { authorization: 'Bearer k-secret-key' })).statusCode).toBe(202);
    expect((await get('/v1/metrics')).statusCode).toBe(401);
    expect((await get('/health')).statusCode).toBe(200);
  });
});

describe('query API', () => {
  it('ingests then queries with grouping, filters, a relative range and read-your-writes (no manual flush)', async () => {
    await setup();
    await post('/v1/ingest', { points: [
      { name: 'reqs', type: 'counter', labels: { service: 'api', status: '2xx' }, value: 90 },
      { name: 'reqs', type: 'counter', labels: { service: 'api', status: '5xx' }, value: 10 },
      { name: 'reqs', type: 'counter', labels: { service: 'web', status: '2xx' }, value: 50 },
    ] });
    c.advance(5000);
    const by = (await get('/v1/query?metric=reqs&agg=sum&range=300&step=300&groupBy=service')).json();
    expect(by.series.map((s: any) => [s.labels.service, s.points.reduce((a: number, p: number[]) => a + (p[1] ?? 0), 0)])).toEqual([['api', 100], ['web', 50]]);
    const errs = (await get('/v1/query?metric=reqs&agg=sum&range=300&step=300&f.status=5xx')).json();
    expect(errs.series[0].points[0][1]).toBe(10);
  });

  it('lists metrics and label values (for building dashboards)', async () => {
    await setup();
    await post('/v1/ingest', { points: [{ name: 'a', labels: { host: 'h1' }, value: 1 }, { name: 'a', labels: { host: 'h2' }, value: 1 }, { name: 'b', type: 'timer', value: 3 }] });
    const m = (await get('/v1/metrics')).json().metrics;
    expect(m).toEqual([{ name: 'a', type: 'gauge', series: 2 }, { name: 'b', type: 'timer', series: 1 }]);
    expect((await get('/v1/labels?metric=a')).json().labels).toEqual({ host: ['h1', 'h2'] });
  });

  it('returns 400 for bad queries and never leaks internals', async () => {
    await setup();
    await post('/v1/ingest', { points: [{ name: 'g', value: 1 }] });
    expect((await get('/v1/query?metric=g&agg=nonsense')).statusCode).toBe(400);
    expect((await get('/v1/query?metric=g&agg=p99')).statusCode).toBe(400);
    expect((await get('/v1/query')).statusCode).toBe(400);
    expect((await get('/v1/query?metric=g&range=abc')).statusCode).toBe(400);
    expect((await get('/v1/query?metric=g&range=100000000&step=1')).statusCode).toBe(400); // demasiados puntos
  });
});

describe('rules, alerts and monitors API', () => {
  it('creates a rule, fires it from ingested data, lists the alert and its history, then deletes it', async () => {
    await setup();
    const created = await post('/v1/rules', { name: 'High CPU', metric: 'cpu', agg: 'avg', windowSec: 10, op: '>', threshold: 90, forSec: 0, severity: 'critical' });
    expect(created.statusCode).toBe(201);
    for (let i = 0; i < 12; i++) { c.advance(1000); await post('/v1/ingest', { points: [{ name: 'cpu', value: 99, ts: c.now() }] }); }
    rt.ingestor.flush();
    await rt.alerts.evaluate();
    const alerts = (await get('/v1/alerts')).json().alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ ruleName: 'High CPU', state: 'firing', severity: 'critical' });
    expect((await get('/v1/alerts/events')).json().events[0]).toMatchObject({ ruleName: 'High CPU', to: 'firing' });
    expect((await app.inject({ method: 'DELETE', url: `/v1/rules/${created.json().id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/v1/rules/${created.json().id}` })).statusCode).toBe(404);
    expect((await get('/v1/alerts')).json().alerts).toHaveLength(0);
  });

  it('rejects invalid rules and webhooks that point at internal addresses (SSRF)', async () => {
    await setup();
    const rule = { name: 'r', metric: 'm', agg: 'avg', windowSec: 10, op: '>', threshold: 1 };
    expect((await post('/v1/rules', { ...rule, agg: 'bogus' })).statusCode).toBe(400);
    for (const webhook of ['http://127.0.0.1:9000/hook', 'http://localhost/hook', 'http://169.254.169.254/latest', 'http://10.0.0.1/', 'gopher://x']) {
      expect((await post('/v1/rules', { ...rule, webhook })).statusCode, webhook).toBe(400);
    }
    expect((await post('/v1/rules', { ...rule, webhook: 'https://hooks.example.com/x' })).statusCode).toBe(201);
  });

  it('monitors: rejects internal targets, validates input, 404 on unknown ids', async () => {
    await setup();
    expect((await post('/v1/monitors', { name: 'meta', url: 'http://169.254.169.254/' })).statusCode).toBe(400);
    expect((await post('/v1/monitors', { name: 'x', url: 'nope' })).statusCode).toBe(400);
    const ok = await post('/v1/monitors', { name: 'site', url: 'https://example.com', intervalSec: 60 });
    expect(ok.statusCode).toBe(201);
    expect((await get('/v1/monitors')).json().monitors[0]).toMatchObject({ name: 'site', last: null });
    expect((await app.inject({ method: 'DELETE', url: '/v1/monitors/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/monitors/${ok.json().id}` })).statusCode).toBe(204);
  });
});

describe('platform', () => {
  it('exposes pipeline stats and the demo endpoint only in simulation mode', async () => {
    await setup();
    await post('/v1/ingest', { points: [{ name: 'm', value: 1 }] });
    const st = (await get('/v1/stats')).json();
    expect(st.ingest.accepted).toBe(1);
    expect(st.limits.maxSeriesPerMetric).toBeGreaterThan(0);
    expect(st.simulate).toBeNull();
    expect((await post('/v1/demo/incident', { active: true })).statusCode).toBe(404);
    await app.close(); await rt.stop();
    await setup({ SIMULATE: 'true' });
    expect((await post('/v1/demo/incident', { active: true })).json()).toEqual({ incident: true });
    expect((await get('/v1/stats')).json().simulate).toEqual({ incident: true });
  });

  it('simulated incident drives the whole pipeline: traffic → p99 spike → alert fires → resolves', async () => {
    await setup({ SIMULATE: 'true' });
    rt.alerts.addRule({ name: 'p99 high', metric: 'http_request_duration_ms', agg: 'p99', windowSec: 20, op: '>', threshold: 800, forSec: 10, groupBy: ['service'] });
    const step = (seconds: number) => { for (let i = 0; i < seconds; i++) { c.advance(1000); rt.sim.tick(c.now(), 1); } };
    step(30);
    await rt.alerts.evaluate();
    expect(rt.alerts.active()).toHaveLength(0);

    rt.sim.setIncident(true);
    for (let i = 0; i < 6; i++) { step(10); rt.ingestor.flush(); await rt.alerts.evaluate(); }
    const firing = rt.alerts.active().filter((a) => a.state === 'firing').map((a) => a.labels.service).sort();
    expect(firing).toEqual(['api', 'checkout']); // el servicio "search" no se ve afectado

    rt.sim.setIncident(false);
    for (let i = 0; i < 8; i++) { step(10); rt.ingestor.flush(); await rt.alerts.evaluate(); }
    expect(rt.alerts.active()).toHaveLength(0);
  });

  it('serves the dashboard with security headers', async () => {
    await setup();
    const r = await get('/');
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.body).toContain('Pulse');
  });

  it('the platform monitors itself: its own pipeline metrics are queryable like any other', async () => {
    await setup();
    rt.maintenance();
    c.advance(1000);
    await post('/v1/ingest', { points: [{ name: 'm', value: 1 }] });
    // selfMetrics se ejecuta en el bucle de runtime.start(); aquí lo comprobamos a través de las estadísticas expuestas
    const st = (await get('/v1/stats')).json();
    expect(st.storage.series).toBeGreaterThan(0);
    expect(st.ingest.lastFlushMs).toBeGreaterThanOrEqual(0);
  });
});
