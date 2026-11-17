import { buildApp } from './api/app.js';
import { createPgDb, createPgliteDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createSystem } from './system.js';

const port = Number(process.env.PORT ?? 4200);
const databaseUrl = process.env.DATABASE_URL;
const role = process.env.ROLE ?? 'all'; // all | api | worker
const adminToken = process.env.ADMIN_TOKEN;

if (process.env.NODE_ENV === 'production' && !adminToken) {
  console.warn('WARNING: ADMIN_TOKEN is not set; /api/admin/* is open.');
}
if (!databaseUrl && role !== 'all') throw new Error('ROLE=api|worker requires DATABASE_URL (PGlite is single-process).');

const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const db = databaseUrl ? createPgDb(databaseUrl) : createPgliteDb(process.env.PGLITE_DIR);
if (await migrate(db)) log('schema created');

const system = await createSystem({ db, log });

// Datos de demostración.
await db.tx(async (q) => {
  for (const [sku, n] of [['KEYBOARD', 40], ['MOUSE', 25], ['MONITOR', 8], ['WEBCAM', 15]] as const) {
    await q.query(`INSERT INTO stock(sku, available) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [sku, n]);
  }
});

const app = role === 'worker' ? null : await buildApp({ system, adminToken });
if (role !== 'api') system.start();
if (app) await app.listen({ port, host: '0.0.0.0' });
log('started', { role, port, db: databaseUrl ? 'postgres' : 'pglite (dev only)' });

const shutdown = async (sig: string) => {
  log('shutting down', { sig });
  await app?.close();
  await system.stop(); // espera a que terminen las entregas en curso
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
