import type { Db } from './db/index.js';
import { Broker } from './broker/broker.js';
import { Relay, type RelayHooks } from './broker/outbox.js';
import { Worker, type WorkerOptions } from './broker/worker.js';
import { Metrics } from './broker/metrics.js';
import { buildConsumers } from './services/consumers.js';
import { defaultChaos, FakeGateway, FakeMailer, type Chaos } from './services/gateway.js';

export interface SystemOptions {
  db: Db;
  now?: () => Date;
  rng?: () => number;
  worker?: WorkerOptions;
  relayHooks?: RelayHooks;
  log?: (msg: string, extra?: object) => void;
}

export interface System {
  db: Db;
  broker: Broker;
  relay: Relay;
  workers: Worker[];
  chaos: Chaos;
  gateway: FakeGateway;
  mailer: FakeMailer;
  metrics: Metrics;
  now: () => Date;
  /** Avanza el sistema de forma determinista hasta que no quede trabajo listo (para tests y demos). */
  drain(maxRounds?: number): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export async function createSystem(opts: SystemOptions): Promise<System> {
  const now = opts.now ?? (() => new Date());
  const rng = opts.rng ?? Math.random;
  const chaos = defaultChaos();
  const gateway = new FakeGateway(chaos, rng);
  const mailer = new FakeMailer(chaos, rng);
  const metrics = opts.worker?.metrics ?? new Metrics();
  const broker = new Broker(opts.db);
  const relay = new Relay(opts.db, broker, now, 200, opts.relayHooks);

  const defs = buildConsumers({ gateway, mailer, chaos });
  for (const d of defs) await broker.subscribe(d.name, d.topics);
  const workers = defs.map((d) => new Worker(opts.db, broker, d, { now, rng, metrics, log: opts.log, ...opts.worker }));

  return {
    db: opts.db, broker, relay, workers, chaos, gateway, mailer, metrics, now,
    async drain(maxRounds = 200) {
      let total = 0;
      for (let round = 0; round < maxRounds; round++) {
        let did = await relay.runOnce();
        for (const w of workers) did += await w.runOnce();
        total += did;
        if (did === 0) return total;
      }
      throw new Error('drain: system did not quiesce (possible event loop)');
    },
    start() {
      relay.start(100, (e) => opts.log?.('relay error', { error: String(e) }));
      for (const w of workers) w.start((e) => opts.log?.('worker error', { consumer: w.def.name, error: String(e) }));
    },
    async stop() {
      relay.stop();
      await Promise.all(workers.map((w) => w.stop()));
    },
  };
}
