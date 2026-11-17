import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Broker } from '../src/broker/broker.js';
import { Relay, writeOutbox } from '../src/broker/outbox.js';
import { Worker } from '../src/broker/worker.js';
import { Metrics } from '../src/broker/metrics.js';
import { backoffMs, PermanentError, type ConsumerDef } from '../src/broker/types.js';
import type { Db } from '../src/db/index.js';
import { count, fakeClock, freshDb } from './helpers.js';

let db: Db;
let broker: Broker;
const clock = fakeClock();
const start = () => new Date('2026-01-01T00:00:00.000Z');

beforeEach(async () => {
  db = await freshDb();
  broker = new Broker(db);
  await broker.subscribe('c1', ['t']);
  await broker.subscribe('c2', ['t', 'u']);
});
afterEach(() => db.close());

const msg = (key = 'k1', topic = 't') => ({ id: randomUUID(), topic, key, payload: { n: Math.random() } });
const stateOf = (id: number) => db.tx(async (q) => (await q.query<any>(`SELECT state, attempts, available_at, last_error FROM deliveries WHERE id=$1`, [id]))[0]);

describe('backoffMs', () => {
  const policy = { maxAttempts: 5, baseMs: 1000, capMs: 60_000 };
  it('grows exponentially, is capped, and never returns 0 (equal jitter)', () => {
    expect(backoffMs(1, policy, () => 1)).toBe(1000);
    expect(backoffMs(3, policy, () => 1)).toBe(4000);
    expect(backoffMs(3, policy, () => 0)).toBe(2000); // mitad fija
    expect(backoffMs(20, policy, () => 1)).toBe(60_000); // tope
    for (let i = 1; i < 30; i++) expect(backoffMs(i, policy)).toBeGreaterThan(0);
  });
});

describe('broker: publish & fan-out', () => {
  it('creates one delivery per subscribed consumer group only', async () => {
    await broker.publish([msg('a', 't'), msg('a', 'u')], start());
    expect(await count(db, 'deliveries', `consumer='c1'`)).toBe(1); // c1 solo escucha 't'
    expect(await count(db, 'deliveries', `consumer='c2'`)).toBe(2);
  });

  it('ignores a duplicate publish of the same message id', async () => {
    const m = msg();
    expect(await broker.publish([m], start())).toBe(1);
    expect(await broker.publish([m, m], start())).toBe(0);
    expect(await count(db, 'deliveries', `consumer='c1'`)).toBe(1);
  });
});

describe('broker: claim, lease and crash recovery', () => {
  it('a leased delivery is invisible to other workers until the lease expires, then is reclaimed (attempt 2)', async () => {
    await broker.publish([msg()], start());
    const [d] = await broker.claim('c1', 'w1', 10, 30_000, start());
    expect(d!.attempts).toBe(1);
    expect(await broker.claim('c1', 'w2', 10, 30_000, new Date(start().getTime() + 10_000))).toHaveLength(0);
    const [again] = await broker.claim('c1', 'w2', 10, 30_000, new Date(start().getTime() + 31_000));
    expect(again!.id).toBe(d!.id);
    expect(again!.attempts).toBe(2); // un crash cuenta como intento: un mensaje venenoso acaba en la DLQ
  });

  it('delivers per-key FIFO: the next message of a key waits, other keys run in parallel', async () => {
    const [a1, a2, b1] = [msg('A'), msg('A'), msg('B')];
    await broker.publish([a1, a2, b1], start());
    const first = await broker.claim('c1', 'w', 10, 30_000, start());
    expect(first.map((d) => d.messageId).sort()).toEqual([a1.id, b1.id].sort()); // a2 NO
    // aunque pidamos más, a2 sigue bloqueado mientras a1 no termine
    expect(await broker.claim('c1', 'w', 10, 30_000, start())).toHaveLength(0);
    await db.tx((q) => q.query(`UPDATE deliveries SET state='done' WHERE message_id=$1`, [a1.id]));
    const next = await broker.claim('c1', 'w', 10, 30_000, start());
    expect(next.map((d) => d.messageId)).toEqual([a2.id]);
  });

  it('respects available_at (backoff) when claiming', async () => {
    await broker.publish([msg()], start());
    const [d] = await broker.claim('c1', 'w', 1, 30_000, start());
    await broker.fail(d!, 'w', new Error('boom'), start(), { maxAttempts: 5, baseMs: 1000, capMs: 60_000 }, () => 1);
    expect(await broker.claim('c1', 'w', 1, 30_000, new Date(start().getTime() + 500))).toHaveLength(0);
    expect(await broker.claim('c1', 'w', 1, 30_000, new Date(start().getTime() + 1001))).toHaveLength(1);
  });
});

describe('broker: retries and dead-letter queue', () => {
  const policy = { maxAttempts: 3, baseMs: 1000, capMs: 60_000 };

  it('retries with growing delays and moves to the DLQ after maxAttempts', async () => {
    await broker.publish([msg()], start());
    let t = start().getTime();
    const outcomes: string[] = [];
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [d] = await broker.claim('c1', 'w', 1, 30_000, new Date(t));
      const out = await broker.fail(d!, 'w', new Error('nope'), new Date(t), policy, () => 1);
      outcomes.push(out);
      const row = await stateOf(d!.id);
      delays.push(new Date(row.available_at).getTime() - t);
      t += 100_000;
    }
    expect(outcomes).toEqual(['retry', 'retry', 'dead']);
    expect(delays.slice(0, 2)).toEqual([1000, 2000]);
    expect(await broker.deadLetters()).toHaveLength(1);
  });

  it('a permanent error skips retries and goes straight to the DLQ', async () => {
    await broker.publish([msg()], start());
    const [d] = await broker.claim('c1', 'w', 1, 30_000, start());
    expect(await broker.fail(d!, 'w', new PermanentError('invalid payload'), start(), policy)).toBe('dead');
    expect((await stateOf(d!.id)).last_error).toContain('invalid payload');
  });

  it('replay puts a dead letter back in the queue with a fresh attempt counter', async () => {
    await broker.publish([msg()], start());
    const [d] = await broker.claim('c1', 'w', 1, 30_000, start());
    await broker.fail(d!, 'w', new PermanentError('x'), start(), policy);
    expect(await broker.replay(d!.id, start())).toBe(true);
    expect(await broker.replay(d!.id, start())).toBe(false); // ya no está muerta
    const [again] = await broker.claim('c1', 'w', 1, 30_000, start());
    expect(again!.attempts).toBe(1);
  });

  it('fail() from a worker that lost its lease is ignored', async () => {
    await broker.publish([msg()], start());
    const [d] = await broker.claim('c1', 'w1', 1, 1000, start());
    await broker.claim('c1', 'w2', 1, 30_000, new Date(start().getTime() + 5000)); // w2 la roba
    expect(await broker.fail(d!, 'w1', new Error('late'), start(), policy)).toBe('lost');
  });

  it('exposes queue stats', async () => {
    await broker.publish([msg('a'), msg('b')], start());
    const [d] = await broker.claim('c1', 'w', 1, 30_000, start());
    await broker.fail(d!, 'w', new PermanentError('x'), start(), policy);
    const s = (await broker.stats(new Date(start().getTime() + 5000))).find((x) => x.consumer === 'c1')!;
    expect(s).toMatchObject({ dead: 1, ready: 1, processing: 0 });
    expect(s.oldestReadyAgeSec).toBe(5);
  });
});

describe('worker: idempotency, atomicity and fencing', () => {
  const run = (def: Partial<ConsumerDef> & Pick<ConsumerDef, 'handler'>, metrics = new Metrics()) =>
    new Worker(db, broker, { name: 'c1', topics: ['t'], ...def }, { now: clock.now, rng: () => 1, metrics, concurrency: 5 });

  it('processes a redelivered message only once (inbox)', async () => {
    await broker.publish([msg()], clock.now());
    let calls = 0;
    const metrics = new Metrics();
    const w = run({ handler: async ({ q }) => { calls++; await q.query(`INSERT INTO notifications(order_id, kind, recipient, created_at) VALUES ($1,'x','r',now())`, [randomUUID()]); } }, metrics);
    await w.runOnce();
    // Simulamos una redelivery (p. ej. el ack se perdió): la entrega vuelve a pending.
    await db.tx((q) => q.query(`UPDATE deliveries SET state='pending', available_at=$1::timestamptz`, [clock.now()]));
    await w.runOnce();
    expect(calls).toBe(1);
    expect(await count(db, 'notifications')).toBe(1);
    expect(metrics.get('broker_duplicates_skipped_total', { consumer: 'c1' })).toBe(1);
    expect(await count(db, 'deliveries', `state='done'`)).toBe(1);
  });

  it('a failing handler rolls back its side effects AND its outgoing events', async () => {
    await broker.publish([msg()], clock.now());
    const w = run({
      handler: async ({ q, emit }) => {
        await q.query(`INSERT INTO notifications(order_id, kind, recipient, created_at) VALUES ($1,'x','r',now())`, [randomUUID()]);
        await emit('other.topic', { hello: 1 });
        throw new Error('crash after side effects');
      },
    });
    await w.runOnce();
    expect(await count(db, 'notifications')).toBe(0);
    expect(await count(db, 'outbox')).toBe(0); // ningún evento "fantasma"
    expect(await count(db, 'processed_messages')).toBe(0); // no quedó marcado: se reintentará
    expect(await count(db, 'deliveries', `state='pending' AND attempts=1`)).toBe(1);
  });

  it('commits side effects, events and the ack atomically on success', async () => {
    await broker.publish([msg('K')], clock.now());
    await run({ handler: async ({ emit }) => emit('next.topic', { ok: true }) }).runOnce();
    expect(await count(db, 'outbox', `topic='next.topic' AND key='K'`)).toBe(1); // hereda la clave de orden
    expect(await count(db, 'deliveries', `state='done'`)).toBe(1);
  });

  it('fencing: if the lease was stolen mid-handler, nothing is committed', async () => {
    await broker.publish([msg()], clock.now());
    const metrics = new Metrics();
    const w = run({
      handler: async ({ q }) => {
        await q.query(`INSERT INTO notifications(order_id, kind, recipient, created_at) VALUES ($1,'x','r',now())`, [randomUUID()]);
        // otro worker "roba" la entrega mientras éste sigue trabajando
        await q.query(`UPDATE deliveries SET locked_by='someone-else'`);
      },
    }, metrics);
    await w.runOnce();
    expect(await count(db, 'notifications')).toBe(0);
    expect(metrics.get('broker_lease_lost_total', { consumer: 'c1' })).toBe(1);
  });

  it('metrics count successes and failures by outcome', async () => {
    await broker.publish([msg('a'), msg('b')], clock.now());
    const metrics = new Metrics();
    let n = 0;
    await run({ handler: async () => { if (n++ === 0) throw new PermanentError('bad'); } }, metrics).runOnce();
    expect(metrics.get('broker_processed_total', { consumer: 'c1' })).toBe(1);
    expect(metrics.get('broker_failures_total', { consumer: 'c1', outcome: 'dead' })).toBe(1);
    expect(metrics.render()).toContain('broker_processed_total{consumer="c1"} 1');
  });
});

describe('transactional outbox + relay', () => {
  it('a relay crash between publish and mark causes a re-publish, never a duplicate delivery', async () => {
    await db.tx((q) => writeOutbox(q, { source: 's', topic: 't', key: 'k', payload: { a: 1 }, now: clock.now() }));

    let crash = true;
    const flaky = new Relay(db, broker, clock.now, 100, { afterPublish: () => { if (crash) throw new Error('relay died'); } });
    await expect(flaky.runOnce()).rejects.toThrow('relay died');
    expect(await count(db, 'outbox', 'published_at IS NULL')).toBe(1); // no quedó marcado
    expect(await count(db, 'messages')).toBe(1); // pero sí se publicó

    crash = false;
    await flaky.runOnce(); // republica
    expect(await count(db, 'outbox', 'published_at IS NULL')).toBe(0);
    expect(await count(db, 'messages')).toBe(1);
    expect(await count(db, 'deliveries', `consumer='c1'`)).toBe(1); // sin duplicados
  });

  it('two relays racing publish each event once, in order', async () => {
    for (let i = 0; i < 20; i++) await db.tx((q) => writeOutbox(q, { source: 's', topic: 't', key: 'k', payload: { i }, now: clock.now() }));
    const [r1, r2] = [new Relay(db, broker, clock.now, 7), new Relay(db, broker, clock.now, 7)];
    for (let i = 0; i < 6; i++) await Promise.all([r1.runOnce(), r2.runOnce()]);
    expect(await count(db, 'deliveries', `consumer='c1'`)).toBe(20);
    const order = await db.tx((q) => q.query<any>(`SELECT (m.payload->>'i')::int AS i FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.consumer='c1' ORDER BY d.id`));
    expect(order.map((r: any) => r.i)).toEqual([...Array(20).keys()]);
  });
});

// Solo con un Postgres real (TEST_DATABASE_URL): PGlite tiene una única conexión y no puede ejercitar la concurrencia real.
describe.runIf(process.env.TEST_DATABASE_URL)('real Postgres: competing workers (SKIP LOCKED)', () => {
  it('N workers over M messages process each message exactly once', async () => {
    await broker.publish(Array.from({ length: 60 }, (_, i) => msg(`key-${i}`)), start());
    const seen = new Map<string, number>();
    const mk = () => new Worker(db, broker, {
      name: 'c1', topics: ['t'],
      handler: async ({ msg }) => { seen.set(msg.id, (seen.get(msg.id) ?? 0) + 1); },
    }, { now: () => new Date(), concurrency: 5 });
    const workers = [mk(), mk(), mk(), mk()];
    for (let i = 0; i < 6; i++) await Promise.all(workers.map((w) => w.runOnce()));
    expect(seen.size).toBe(60);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });
});
