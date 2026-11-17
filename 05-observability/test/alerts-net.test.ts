import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import dns from 'node:dns';
import { AlertEngine, type Notifier } from '../src/alerts.js';
import { MemoryNotifier, WebhookNotifier } from '../src/notifier.js';
import { createSafeFetch, isPrivateIp, UnsafeTargetError, type SafeFetch } from '../src/net.js';
import { MonitorRunner } from '../src/monitors.js';
import { runQuery } from '../src/query.js';
import { T0, makeSystem } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

/** Escenario: cada segundo ingiere `value(sec)` y evalúa las alertas cada `every` segundos. */
function scenario(rule: Record<string, unknown>, notifier: Notifier = new MemoryNotifier()) {
  const s = makeSystem();
  const engine = new AlertEngine(s.store, s.registry, notifier, s.clock.now);
  engine.addRule(rule);
  const run = async (from: number, to: number, value: (sec: number) => number | null, every = 5, labels: Record<string, string> = {}) => {
    for (let sec = from; sec < to; sec++) {
      s.clock.set(T0 + sec * 1000);
      const v = value(sec);
      if (v !== null) s.ingestor.ingest([{ name: 'lat', type: 'gauge', labels, value: v, ts: s.clock.now() }]);
      if (sec % every === 0) { s.ingestor.flush(); await engine.evaluate(); }
    }
  };
  return { ...s, engine, run, notifier };
}

const RULE = { name: 'High latency', metric: 'lat', agg: 'avg', windowSec: 10, op: '>', threshold: 100, forSec: 20, severity: 'critical' };

describe('alert state machine', () => {
  it('ok → pending → firing only after the condition holds for `forSec`; notifies once; then resolves', async () => {
    const n = new MemoryNotifier();
    const t = scenario(RULE, n);
    await t.run(0, 30, () => 10); // sano
    expect(t.engine.active()).toHaveLength(0);

    await t.run(30, 45, () => 500); // mal pero < forSec: pending
    expect(t.engine.active()[0]).toMatchObject({ state: 'pending' });
    expect(n.sent).toHaveLength(0);

    await t.run(45, 90, () => 500); // sostenido: firing, UNA sola notificación (no una por evaluación)
    expect(t.engine.active()[0]).toMatchObject({ state: 'firing' });
    expect(n.sent.map((x) => x.state)).toEqual(['firing']);

    await t.run(90, 120, () => 10); // recupera
    expect(t.engine.active()).toHaveLength(0);
    expect(n.sent.map((x) => x.state)).toEqual(['firing', 'resolved']);
    expect(t.engine.events().map((e) => e.to)).toEqual(['ok', 'firing', 'pending']);
  });

  it('a short spike never fires nor notifies (flapping protection)', async () => {
    const n = new MemoryNotifier();
    const t = scenario(RULE, n);
    await t.run(0, 20, () => 10);
    await t.run(20, 25, () => 900); // pico de 5 s
    await t.run(25, 120, () => 10);
    expect(n.sent).toHaveLength(0);
    expect(t.engine.events().filter((e) => e.to === 'firing')).toHaveLength(0);
  });

  it('keeps independent state per group (one service failing does not fire the others)', async () => {
    const n = new MemoryNotifier();
    const t = scenario({ ...RULE, groupBy: ['service'], forSec: 0 }, n);
    for (let sec = 0; sec < 30; sec++) {
      t.clock.set(T0 + sec * 1000);
      t.ingestor.ingest([
        { name: 'lat', labels: { service: 'api' }, value: 10, ts: t.clock.now() },
        { name: 'lat', labels: { service: 'db' }, value: 900, ts: t.clock.now() },
      ]);
      if (sec % 5 === 0) { t.ingestor.flush(); await t.engine.evaluate(); }
    }
    const firing = t.engine.active();
    expect(firing).toHaveLength(1);
    expect(firing[0]!.labels).toEqual({ service: 'db' });
    expect(n.sent).toHaveLength(1);
  });

  it('re-notifies while firing when repeatSec is set', async () => {
    const n = new MemoryNotifier();
    const t = scenario({ ...RULE, forSec: 0, repeatSec: 60 }, n);
    await t.run(0, 200, () => 500);
    expect(n.sent.map((x) => x.state)).toEqual(['firing', 'repeat', 'repeat', 'repeat'].slice(0, n.sent.length));
    expect(n.sent.filter((x) => x.state === 'repeat').length).toBeGreaterThanOrEqual(2);
  });

  it('noData=alert turns silence into an alert (dead-man\'s switch); noData=ok does not', async () => {
    const loud = new MemoryNotifier();
    const a = scenario({ ...RULE, name: 'Heartbeat', metric: 'lat', agg: 'count', op: '<', threshold: 1, forSec: 10, windowSec: 10, noData: 'alert' }, loud);
    await a.run(0, 30, () => 1); // latido presente
    expect(a.engine.active()).toHaveLength(0);
    await a.run(30, 80, () => null); // el emisor se calla
    expect(a.engine.active()[0]).toMatchObject({ state: 'firing', value: null });
    await a.run(80, 100, () => 1); // vuelve
    expect(loud.sent.map((x) => x.state)).toEqual(['firing', 'resolved']);

    const quiet = new MemoryNotifier();
    const b = scenario({ ...RULE, forSec: 0, noData: 'ok' }, quiet);
    await b.run(0, 20, () => 500);
    expect(b.engine.active()).toHaveLength(1);
    await b.run(20, 60, () => null);
    expect(b.engine.active()).toHaveLength(0); // sin datos = condición falsa
  });

  it('state survives a restart: a firing alert is neither lost nor re-notified', async () => {
    const n1 = new MemoryNotifier();
    const t = scenario({ ...RULE, forSec: 0 }, n1);
    await t.run(0, 20, () => 500);
    expect(n1.sent).toHaveLength(1);

    const n2 = new MemoryNotifier();
    const restarted = new AlertEngine(t.store, t.registry, n2, t.clock.now); // "nuevo proceso", misma base de datos
    expect(restarted.active()[0]).toMatchObject({ state: 'firing' });
    expect(restarted.listRules()).toHaveLength(1);
    t.clock.advance(5000);
    t.ingestor.ingest([{ name: 'lat', value: 500, ts: t.clock.now() }]);
    t.ingestor.flush();
    await restarted.evaluate();
    expect(n2.sent).toHaveLength(0); // sigue disparada, sin duplicar el aviso
  });

  it('validates rules and supports deletion (which also clears its state)', async () => {
    const t = scenario(RULE);
    expect(() => t.engine.addRule({ ...RULE, agg: 'median' })).toThrow();
    expect(() => t.engine.addRule({ ...RULE, windowSec: 1 })).toThrow();
    expect(() => t.engine.addRule({ ...RULE, op: '!=' })).toThrow();
    await t.run(0, 20, () => 500);
    const id = t.engine.listRules()[0]!.id;
    expect(t.engine.deleteRule(id)).toBe(true);
    expect(t.engine.active()).toHaveLength(0);
    expect(t.engine.deleteRule(id)).toBe(false);
  });
});

describe('SSRF protection', () => {
  it.each([
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.16.0.1', true], ['172.32.0.1', false], ['192.168.1.1', true],
    ['169.254.169.254', true], ['100.64.0.1', true], ['0.0.0.0', true], ['224.0.0.1', true], ['8.8.8.8', false], ['1.1.1.1', false],
    ['::1', true], ['fe80::1', true], ['fd00::1', true], ['::ffff:127.0.0.1', true], ['::ffff:7f00:1', true], ['2606:4700::1111', false], ['not-an-ip', true],
  ])('isPrivateIp(%s) → %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  const safe = createSafeFetch(false);
  it.each([
    'http://127.0.0.1:8080/', 'http://localhost/admin', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.5/',
    'file:///etc/passwd', 'ftp://example.com/', 'http://user:pass@example.com/',
  ])('refuses %s', async (url) => {
    await expect(safe(url)).rejects.toBeInstanceOf(UnsafeTargetError);
  });

  it('blocks DNS rebinding: a hostname that RESOLVES to a private address is refused at connect time', async () => {
    const real = dns.lookup;
    vi.spyOn(dns, 'lookup').mockImplementation(((host: string, opts: any, cb: any) => {
      if (host === 'evil.example.test') return cb(null, [{ address: '127.0.0.1', family: 4 }]);
      return (real as any)(host, opts, cb);
    }) as any);
    await expect(safe('http://evil.example.test/')).rejects.toThrow(/blocked address 127\.0\.0\.1/);
  });

  it('does not follow redirects (a public URL cannot bounce the request to the internal network)', async () => {
    const server = http.createServer((_q, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }).end(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    const res = await createSafeFetch(true)(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(302); // se devuelve tal cual; no se sigue
    server.close();
  });
});

describe('webhook delivery', () => {
  const rule = { id: 'r1', name: 'x', metric: 'm', agg: 'avg', windowSec: 10, op: '>', threshold: 1, forSec: 0, severity: 'critical', noData: 'ok', webhook: 'https://hooks.example.com/a' } as any;
  const note = { rule, state: 'firing', labels: { service: 'api' }, value: 3, at: T0 } as const;
  const fetchSeq = (...statuses: Array<number | Error>): { fn: SafeFetch; calls: number } => {
    const o = { calls: 0, fn: (async () => { const s = statuses[Math.min(o.calls++, statuses.length - 1)]!; if (s instanceof Error) throw s; return { status: s, ok: s < 400, text: async () => '' }; }) as SafeFetch };
    return o;
  };

  it('retries 5xx with exponential backoff and then succeeds', async () => {
    const f = fetchSeq(503, 500, 200);
    const sleeps: number[] = [];
    const n = new WebhookNotifier({ fetchImpl: f.fn, sleep: async (ms) => void sleeps.push(ms), baseMs: 100 });
    expect(await n.send(note)).toBe('delivered');
    expect(f.calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('does not retry 4xx and reports failure after exhausting retries on 5xx', async () => {
    const a = fetchSeq(400);
    expect(await new WebhookNotifier({ fetchImpl: a.fn, sleep: async () => {} }).send(note)).toBe('failed');
    expect(a.calls).toBe(1);
    const b = fetchSeq(500);
    expect(await new WebhookNotifier({ fetchImpl: b.fn, sleep: async () => {}, retries: 2 }).send(note)).toBe('failed');
    expect(b.calls).toBe(3);
  });

  it('never retries blocked (SSRF) targets, and sends nothing when there is no webhook', async () => {
    const f = fetchSeq(new UnsafeTargetError('blocked address 10.0.0.1'));
    expect(await new WebhookNotifier({ fetchImpl: f.fn, sleep: async () => {} }).send(note)).toBe('failed');
    expect(f.calls).toBe(1);
    expect(await new WebhookNotifier({ fetchImpl: f.fn }).send({ ...note, rule: { ...rule, webhook: undefined } })).toBe('none');
  });

  it('sends a useful JSON payload', async () => {
    let body: any;
    const fn: SafeFetch = async (_u, init) => { body = JSON.parse(init!.body!); return { status: 200, ok: true, text: async () => '' }; };
    await new WebhookNotifier({ fetchImpl: fn }).send(note);
    expect(body).toMatchObject({ status: 'firing', rule: 'x', severity: 'critical', labels: { service: 'api' }, value: 3 });
    expect(body.condition).toBe('avg(m) > 1 over 10s');
  });
});

describe('uptime monitors', () => {
  const startServer = async (handler: http.RequestListener) => {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => server.close() };
  };

  it('records success, failure and latency as ordinary metrics (queryable and alertable)', async () => {
    const ok = await startServer((_q, res) => res.writeHead(200).end('ok'));
    const bad = await startServer((_q, res) => res.writeHead(500).end('boom'));
    const slow = await startServer(() => { /* nunca responde */ });
    const s = makeSystem({ ALLOW_PRIVATE_TARGETS: 'true' });
    const runner = new MonitorRunner(s.store, s.ingestor, createSafeFetch(true), { allowPrivate: true, now: s.clock.now });
    const mOk = runner.add({ name: 'site-ok', url: ok.url });
    const mBad = runner.add({ name: 'site-bad', url: bad.url });
    const mSlow = runner.add({ name: 'site-slow', url: slow.url, timeoutMs: 300 });

    expect(await runner.runCheck(mOk)).toMatchObject({ ok: true, status: 200 });
    expect(await runner.runCheck(mBad)).toMatchObject({ ok: false, status: 500, error: 'unexpected status 500' });
    const t = await runner.runCheck(mSlow);
    expect(t).toMatchObject({ ok: false, status: null, error: 'timeout' });

    s.ingestor.flush();
    const res = runQuery(s.store, s.registry, { metric: 'uptime_check_success', agg: 'avg', from: T0, to: T0 + 60_000, stepSec: 60, groupBy: ['monitor'] }, s.clock.now());
    expect(res.series.map((x) => [x.labels.monitor, x.points[0]![1]])).toEqual([['site-bad', 0], ['site-ok', 1], ['site-slow', 0]]);
    expect(runner.list().find((m) => m.name === 'site-ok')!.last!.ok).toBe(true);
    [ok, bad, slow].forEach((x) => x.close());
  });

  it('honours expectStatus and persists monitors across restarts', async () => {
    const srv = await startServer((_q, res) => res.writeHead(404).end());
    const s = makeSystem({ ALLOW_PRIVATE_TARGETS: 'true' });
    const runner = new MonitorRunner(s.store, s.ingestor, createSafeFetch(true), { allowPrivate: true, now: s.clock.now });
    const m = runner.add({ name: 'expects-404', url: srv.url, expectStatus: 404 });
    expect((await runner.runCheck(m)).ok).toBe(true);
    const again = new MonitorRunner(s.store, s.ingestor, createSafeFetch(true), { allowPrivate: true, now: s.clock.now });
    expect(again.list().map((x) => x.name)).toEqual(['expects-404']);
    srv.close();
  });

  it('refuses to create monitors pointing at internal addresses', () => {
    const s = makeSystem();
    const runner = new MonitorRunner(s.store, s.ingestor, createSafeFetch(false), { allowPrivate: false, now: s.clock.now });
    expect(() => runner.add({ name: 'meta', url: 'http://169.254.169.254/latest/meta-data/' })).toThrow(UnsafeTargetError);
    expect(() => runner.add({ name: 'local', url: 'http://localhost:5432/' })).toThrow(UnsafeTargetError);
    expect(() => runner.add({ name: 'bad name!', url: 'https://example.com' })).toThrow();
  });
});
