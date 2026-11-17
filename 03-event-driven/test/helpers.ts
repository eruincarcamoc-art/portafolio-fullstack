import { createPgliteDb, createPgDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createSystem, type System, type SystemOptions } from '../src/system.js';
import { placeOrder } from '../src/services/orders.js';
import { randomUUID } from 'node:crypto';

/** Reloj controlado: los tests avanzan el tiempo (backoff, leases) sin dormir. */
export function fakeClock(start = '2026-01-01T00:00:00.000Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => void (t += ms),
  };
}

export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const db = createPgDb(url, 20);
    await db.tx((q) => q.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`));
    await migrate(db);
    return db;
  }
  const db = createPgliteDb();
  await migrate(db);
  return db;
}

export async function freshSystem(opts: Partial<SystemOptions> = {}) {
  const clock = fakeClock();
  const db = opts.db ?? (await freshDb());
  const system = await createSystem({ db, now: clock.now, rng: () => 0.5, ...opts });
  await seedStock(db, { KEYBOARD: 100, MOUSE: 100, MONITOR: 5 });
  return { system, db, clock };
}

export async function seedStock(db: Db, stock: Record<string, number>) {
  await db.tx(async (q) => {
    for (const [sku, n] of Object.entries(stock)) {
      await q.query(`INSERT INTO stock(sku, available) VALUES ($1,$2) ON CONFLICT (sku) DO UPDATE SET available=$2`, [sku, n]);
    }
  });
}

export async function order(system: System, items: Array<{ sku: string; qty?: number; priceCents?: number }>, customerId = 'ana@example.com') {
  const r = await placeOrder(
    system.db,
    { customerId, items: items.map((i) => ({ sku: i.sku, qty: i.qty ?? 1, priceCents: i.priceCents ?? 1000 })) },
    randomUUID(),
    system.now(),
  );
  return r.body.id;
}

export const orderRow = (db: Db, id: string) =>
  db.tx(async (q) => (await q.query<any>(`SELECT status, cancel_reason FROM orders WHERE id=$1`, [id]))[0]);

export const stockRow = (db: Db, sku: string) =>
  db.tx(async (q) => (await q.query<any>(`SELECT available, reserved FROM stock WHERE sku=$1`, [sku]))[0]);

export const count = (db: Db, table: string, where = 'true') =>
  db.tx(async (q) => Number((await q.query<any>(`SELECT count(*)::int AS c FROM ${table} WHERE ${where}`))[0].c));
