import { FileOpLog } from './oplog.js';
import { startServer } from './server.js';

const port = Number(process.env.PORT ?? 4100);
const dataDir = process.env.DATA_DIR ?? './data';
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());

if (process.env.NODE_ENV === 'production' && allowedOrigins.includes('*')) {
  console.warn('WARNING: ALLOWED_ORIGINS=* in production. Set it to your web origin.');
}

const running = await startServer(port, {
  store: new FileOpLog(dataDir),
  allowedOrigins,
  log: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra })),
});

const shutdown = async (sig: string) => {
  console.log(`${sig}: shutting down`);
  await running.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
