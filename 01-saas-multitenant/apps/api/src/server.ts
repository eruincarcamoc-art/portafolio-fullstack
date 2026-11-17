import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
const db = createDb(config);
const applied = await migrate(db);

const app = await buildApp({ config, db });
if (applied.length) app.log.info({ applied }, 'migrations applied');
if (!config.DATABASE_URL) app.log.warn('DATABASE_URL not set: using embedded PGlite (dev only)');
if (app.billing.kind === 'fake') app.log.warn('Stripe not configured: using fake billing provider');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: '0.0.0.0' });
