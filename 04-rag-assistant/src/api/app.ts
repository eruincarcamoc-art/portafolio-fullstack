import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { BudgetExceeded, checkBudget, RateLimited, SlidingWindowLimiter, usageSummary } from '../cost.js';
import { ProviderError, type Embedder, type Llm } from '../providers/types.js';
import { answerQuestion, type AnswerDeps } from '../rag/answer.js';
import { deleteDocument, ingestDocument, listDocuments } from '../rag/ingest.js';
import { uiHtml } from './ui.js';

export interface AppOptions {
  db: Db;
  embedder: Embedder;
  llm: Llm;
  cfg: Config;
  logger?: boolean;
}

const chatSchema = (max: number) =>
  z.object({
    question: z.string().trim().min(2).max(max),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(12).optional(),
  });

const docSchema = z.object({
  title: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(300).optional(),
  content: z.string().min(20).max(500_000),
});

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db, cfg } = opts;
  const deps: AnswerDeps = { db, embedder: opts.embedder, llm: opts.llm, cfg };
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  const limiter = new SlidingWindowLimiter(cfg.RATE_LIMIT_PER_MIN);

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer');
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', cfg.ALLOWED_ORIGIN).header('Access-Control-Allow-Headers', 'content-type, authorization, x-client-id');
    if (req.method === 'OPTIONS') return reply.status(204).send();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation_failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof RateLimited) return reply.status(429).header('Retry-After', String(err.retryAfterSec)).send({ error: 'rate_limited', message: err.message });
    if (err instanceof BudgetExceeded) return reply.status(429).send({ error: 'budget_exceeded', message: err.message });
    if (err instanceof ProviderError) return reply.status(503).send({ error: 'provider_unavailable', message: 'The AI provider is temporarily unavailable. Please retry.' });
    const status = (err as any).statusCode as number | undefined;
    if (status && status < 500) return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal' });
  });

  const clientId = (req: FastifyRequest): string => {
    const h = req.headers['x-client-id'];
    return typeof h === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(h) ? h : `ip:${req.ip}`;
  };

  const requireAdmin = async (req: FastifyRequest) => {
    if (!cfg.ADMIN_TOKEN) return;
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(cfg.ADMIN_TOKEN);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw Object.assign(new Error('Admin token required'), { statusCode: 401 });
  };

  app.get('/health', async () => ({ status: 'ok', embedder: opts.embedder.name, llm: opts.llm.name }));
  app.get('/', async (_req, reply) => reply.type('text/html').send(uiHtml(Boolean(cfg.ADMIN_TOKEN), opts.llm.name, opts.embedder.name)));

  // ------------------------------------------------------------ chat
  /** Valida y aplica límites ANTES de abrir el stream: así los errores salen como HTTP normal (429/400). */
  async function preflight(req: FastifyRequest) {
    const body = chatSchema(cfg.MAX_QUESTION_CHARS).parse(req.body);
    const id = clientId(req);
    limiter.check(id);
    await checkBudget(db, id, cfg.DAILY_TOKEN_BUDGET);
    return { body, id };
  }

  app.post('/api/chat/sync', async (req) => {
    const { body, id } = await preflight(req);
    return answerQuestion(deps, body.question, { clientId: id, history: body.history, enforceBudget: false });
  });

  // Streaming SSE: sources → token… → done. Si el cliente se va, se aborta la llamada al modelo (y el gasto).
  app.post('/api/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const { body, id } = await preflight(req);
    const ac = new AbortController();

    reply.hijack();
    const res = reply.raw;
    // OJO: `req.raw.on('close')` se emite al terminar de LEER el cuerpo, no al cerrarse la conexión.
    // La señal correcta es que la RESPUESTA se cierre sin haberse terminado de escribir.
    res.on('close', () => { if (!res.writableFinished) ac.abort(new Error('client disconnected')); });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // evita que nginx acumule los eventos
      'Access-Control-Allow-Origin': cfg.ALLOWED_ORIGIN,
    });
    const send = (event: string, data: unknown) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    try {
      await answerQuestion(deps, body.question, { clientId: id, history: body.history, signal: ac.signal, enforceBudget: false }, (e) => {
        if (e.type === 'sources') send('sources', e.sources);
        else if (e.type === 'token') send('token', { text: e.text });
        else send('done', e.result);
      });
    } catch (err) {
      if (!ac.signal.aborted) {
        app.log.error(err);
        send('error', { message: err instanceof ProviderError ? 'The AI provider is temporarily unavailable.' : 'Something went wrong.' });
      }
    } finally {
      res.end();
    }
  });

  // ------------------------------------------------------------ documentos
  app.get('/api/documents', async () => ({ items: await listDocuments(db) }));

  app.post('/api/documents', { preHandler: requireAdmin }, async (req, reply) => {
    const d = docSchema.parse(req.body);
    const r = await ingestDocument(db, opts.embedder, { title: d.title, source: d.source ?? `upload:${d.title}`, content: d.content });
    return reply.status(r.status === 'created' ? 201 : 200).send(r);
  });

  app.delete('/api/documents/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = z.coerce.number().int().positive().parse((req.params as any).id);
    return (await deleteDocument(db, id)) ? reply.status(204).send() : reply.status(404).send({ error: 'not_found' });
  });

  // ------------------------------------------------------------ observabilidad
  app.get('/api/usage', { preHandler: requireAdmin }, async () => ({ ...(await usageSummary(db)), budget: { dailyTokensPerClient: cfg.DAILY_TOKEN_BUDGET, ratePerMinute: cfg.RATE_LIMIT_PER_MIN } }));

  app.get('/api/eval', async (_req, reply) => {
    try {
      return JSON.parse(await readFile('eval/last-run.json', 'utf8'));
    } catch {
      return reply.status(404).send({ error: 'no_eval_run', message: 'Run `npm run eval` first.' });
    }
  });

  return app;
}
