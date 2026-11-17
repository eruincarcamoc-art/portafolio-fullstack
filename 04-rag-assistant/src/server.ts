import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { createPgDb, createPgliteDb, migrate } from './db.js';
import { createEmbedder, createLlm } from './providers/index.js';
import { indexCorpus } from './eval/run.js';

const cfg = loadConfig();
const embedder = createEmbedder(cfg);
const llm = createLlm(cfg);
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const db = cfg.DATABASE_URL ? createPgDb(cfg.DATABASE_URL) : createPgliteDb(cfg.PGLITE_DIR);
await migrate(db, embedder.dims);

// Primer arranque: carga el corpus de ejemplo (idempotente: los documentos sin cambios no se re-embeben).
if (process.env.LOAD_SAMPLE_CORPUS !== 'false') {
  await indexCorpus(db, embedder, 'corpus');
  log('sample corpus ready');
}

const app = await buildApp({ db, embedder, llm, cfg, logger: false });
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
log('started', { port: cfg.PORT, llm: llm.name, embedder: embedder.name, db: cfg.DATABASE_URL ? 'postgres+pgvector' : 'pglite (dev only)' });
if (llm.name === 'anthropic' && cfg.PRICE_INPUT_PER_MTOK === 0) log('warning: PRICE_*_PER_MTOK not set; cost tracking will show $0');

const shutdown = async (sig: string) => {
  log('shutting down', { sig });
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
