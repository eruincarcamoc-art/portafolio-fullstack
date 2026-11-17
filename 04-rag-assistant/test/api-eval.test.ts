import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db.js';
import { buildApp } from '../src/api/app.js';
import { checkGate, factsRecall, hitAtK, percentile, reciprocalRank, summarize, type CaseResult, type Thresholds } from '../src/eval/metrics.js';
import { runEval, type GoldenCase } from '../src/eval/run.js';
import { LocalEmbedder, LocalLlm, ScriptedLlm, freshDb, testConfig } from './helpers.js';
import type { Llm } from '../src/providers/types.js';

describe('API', () => {
  let db: Db;
  let app: FastifyInstance;
  const emb = new LocalEmbedder();
  beforeAll(async () => { db = await freshDb(emb, true); });
  afterAll(() => db.close());
  afterEach(() => app?.close());

  const make = async (env: Record<string, string> = {}, llm: Llm = new ScriptedLlm('Passwords must be at least 14 characters long. [1]')) => {
    app = await buildApp({ db, embedder: emb, llm, cfg: testConfig({ RATE_LIMIT_PER_MIN: '1000', ...env }) });
    await app.ready();
    return app;
  };
  const chat = (q: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/chat', payload: q as any, headers: { 'x-client-id': 'tester', ...headers } });
  const parseSse = (body: string) =>
    body.split('\n\n').filter(Boolean).map((raw) => ({ event: /event: (.*)/.exec(raw)![1]!, data: JSON.parse(/data: (.*)/s.exec(raw)![1]!) }));

  it('streams Server-Sent Events in order: sources → tokens → done', async () => {
    await make();
    const res = await chat({ question: 'How long must passwords be?' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(res.body);
    expect(events[0]!.event).toBe('sources');
    expect(events[0]!.data[0].title).toMatch(/Security/);
    expect(events.filter((e) => e.event === 'token').map((e) => e.data.text).join('')).toBe('Passwords must be at least 14 characters long. [1]');
    expect(events.at(-1)!.event).toBe('done');
    expect(events.at(-1)!.data).toMatchObject({ grounded: true, citations: [1] });
  });

  it('works end-to-end with the local offline stack and says "I don\'t know" when the docs do not cover it', async () => {
    await make({}, new LocalLlm());
    const ok = (await app.inject({ method: 'POST', url: '/api/chat/sync', payload: { question: 'How long must passwords be?' }, headers: { 'x-client-id': 'a' } })).json();
    expect(ok.answer).toMatch(/14 characters/);
    expect(ok.citations.length).toBeGreaterThan(0);
    const no = (await app.inject({ method: 'POST', url: '/api/chat/sync', payload: { question: 'What is the weather in Madrid tomorrow?' }, headers: { 'x-client-id': 'a' } })).json();
    expect(no.refused).toBe(true);
  });

  it('validates input before streaming (plain HTTP errors, not a broken stream)', async () => {
    await make({ MAX_QUESTION_CHARS: '50' });
    expect((await chat({ question: 'x' })).statusCode).toBe(400);
    expect((await chat({ question: 'y'.repeat(51) })).statusCode).toBe(400);
    expect((await chat({})).statusCode).toBe(400);
    expect((await chat({ question: 'valid question?', history: [{ role: 'system', content: 'hack' }] })).statusCode).toBe(400);
  });

  it('rate-limits per client with Retry-After, without affecting other clients', async () => {
    await make({ RATE_LIMIT_PER_MIN: '3' });
    for (let i = 0; i < 3; i++) expect((await chat({ question: 'How long must passwords be?' }, { 'x-client-id': 'spammer' })).statusCode).toBe(200);
    const limited = await chat({ question: 'How long must passwords be?' }, { 'x-client-id': 'spammer' });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await chat({ question: 'How long must passwords be?' }, { 'x-client-id': 'polite' })).statusCode).toBe(200);
  });

  it('returns 429 budget_exceeded before opening the stream once the daily token budget is spent', async () => {
    await make({ DAILY_TOKEN_BUDGET: '1' }, new ScriptedLlm('Passwords must be at least 14 characters long. [1]', { inputTokens: 50, outputTokens: 10 }));
    const id = { 'x-client-id': 'budget-client' };
    // (pregunta propia: una respuesta cacheada por otro test costaría 0 tokens y no gastaría presupuesto)
    expect((await chat({ question: 'How often do managers review access rights?' }, id)).statusCode).toBe(200);
    const blocked = await chat({ question: 'How often do managers review access rights?' }, id);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('budget_exceeded');
  });

  it('shows a friendly error event (no stack traces) when the provider fails mid-stream', async () => {
    await make({}, new ScriptedLlm('one two three four five [1]', { inputTokens: 1, outputTokens: 1 }, 2));
    const events = parseSse((await chat({ question: 'What is the daily meal allowance when travelling?' })).body);
    const err = events.find((e) => e.event === 'error')!;
    expect(err.data.message).toBe('Something went wrong.');
    expect(JSON.stringify(events)).not.toContain('upstream exploded');
  });

  it('manages documents; ADMIN_TOKEN protects writes and usage, reads stay open', async () => {
    await make({ ADMIN_TOKEN: 'sekret-token' });
    const body = { title: 'Handbook', content: '# Handbook\n\nThe office opens at nine in the morning every weekday.' };
    expect((await app.inject({ method: 'POST', url: '/api/documents', payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/documents', payload: body, headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    const auth = { authorization: 'Bearer sekret-token' };
    const created = await app.inject({ method: 'POST', url: '/api/documents', payload: body, headers: auth });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/documents', payload: body, headers: auth })).json().status).toBe('unchanged');
    expect((await app.inject({ url: '/api/documents' })).json().items.some((d: any) => d.title === 'Handbook')).toBe(true);
    expect((await app.inject({ url: '/api/usage' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/usage', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/documents/${created.json().documentId}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/api/documents/99999', headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/documents', payload: { title: 'x', content: 'short' }, headers: auth })).statusCode).toBe(400);
  });

  it('reports usage: requests, cache hits, refusals, tokens, latency percentiles', async () => {
    await make();
    await chat({ question: 'How long must passwords be?' }, { 'x-client-id': 'usage-1' });
    const u = (await app.inject({ url: '/api/usage' })).json();
    expect(u.requests).toBeGreaterThan(0);
    expect(u.inputTokens).toBeGreaterThan(0);
    expect(u.p95Ms).toBeGreaterThanOrEqual(u.p50Ms);
    expect(u.budget.ratePerMinute).toBe(1000);
  });

  it('serves the UI with security headers and escapes nothing dangerous into it', async () => {
    await make();
    const r = await app.inject({ url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.body).toContain('Docs Assistant');
    expect(r.body).toContain('esc(');
  });
});

describe('evaluation metrics', () => {
  it('hit@k, reciprocal rank and facts recall', () => {
    const docs = ['b.md', 'a.md', 'c.md'];
    expect(hitAtK(docs, ['a.md'], 1)).toBe(0);
    expect(hitAtK(docs, ['a.md'], 2)).toBe(1);
    expect(reciprocalRank(docs, ['a.md'])).toBe(0.5);
    expect(reciprocalRank(docs, ['z.md'])).toBe(0);
    expect(factsRecall('Passwords need 14 CHARACTERS.', [['14 characters'], ['mandatory', 'required']])).toBe(0.5);
    expect(factsRecall('anything', [])).toBe(1);
  });
  it('percentile', () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([], 95)).toBe(0);
  });

  const base: CaseResult = {
    id: 'x', kind: 'direct', answerable: true, question: 'q', retrievedDocs: ['a'], hit1: 1, hit3: 1, hit5: 1, rr: 1, answer: 'a [1]',
    factsRecall: 1, refused: false, grounded: true, citationsValid: true, citationPrecision: 1, latencyMs: 10, signals: { topSimilarity: 0.5, coverage: 0.5 },
  };
  it('summarises answerable and unanswerable cases separately', () => {
    const s = summarize([
      base,
      { ...base, id: 'y', hit1: 0, hit3: 0, hit5: 0, rr: 0, factsRecall: 0, refused: true },
      { ...base, id: 'n', kind: 'unanswerable', answerable: false, refused: true, citationPrecision: null },
      { ...base, id: 'm', kind: 'unanswerable', answerable: false, refused: false, citationPrecision: null },
    ]);
    expect(s.retrieval.hit5).toBe(0.5);
    expect(s.generation.correctRate).toBe(0.5);
    expect(s.refusal.unanswerableRefused).toBe(0.5);
    expect(s.refusal.answerableRefusedWrongly).toBe(0.5);
  });
  it('the gate reports every violated threshold and passes otherwise', () => {
    const th: Thresholds = { retrieval: { hit5: 0.9, mrr: 0.9 }, generation: { correctRate: 0.8, groundedRate: 0.9, citationPrecision: 0.9 }, refusal: { unanswerableRefused: 0.8, answerableRefusedWrongly: 0.1 } };
    const good = summarize([base]);
    expect(checkGate(good, th)).toEqual([]);
    const bad = summarize([{ ...base, hit5: 0, rr: 0, refused: true, factsRecall: 0 }]);
    const fails = checkGate(bad, th);
    expect(fails.some((f) => f.startsWith('retrieval.hit5'))).toBe(true);
    expect(fails.some((f) => f.startsWith('refusal.answerableRefusedWrongly'))).toBe(true);
  });
});

describe('quality gate on the real corpus (this is what CI enforces)', () => {
  it('the shipped pipeline meets eval/thresholds.json on the golden set', async () => {
    const emb = new LocalEmbedder();
    const db = await freshDb(emb, true);
    const golden: GoldenCase[] = JSON.parse(await readFile('eval/golden.json', 'utf8'));
    const thresholds: Thresholds = JSON.parse(await readFile('eval/thresholds.json', 'utf8'));
    const { summary, cases } = await runEval({ db, embedder: emb, llm: new LocalLlm(), cfg: testConfig() }, golden, 'hybrid');
    expect(checkGate(summary, thresholds)).toEqual([]);
    // la evaluación ejecuta el pipeline de verdad y no contamina el presupuesto de usuarios reales
    expect(cases).toHaveLength(golden.length);
    await db.close();
  });

  it('hybrid retrieval is at least as good as either single method (the reason hybrid exists)', async () => {
    const emb = new LocalEmbedder();
    const db = await freshDb(emb, true);
    const golden: GoldenCase[] = (JSON.parse(await readFile('eval/golden.json', 'utf8')) as GoldenCase[]).filter((g) => g.answerable);
    const run = async (mode: 'hybrid' | 'vector' | 'lexical') => (await runEval({ db, embedder: emb, llm: new LocalLlm(), cfg: testConfig() }, golden, mode)).summary.retrieval;
    const [h, v, l] = [await run('hybrid'), await run('vector'), await run('lexical')];
    expect(h.mrr).toBeGreaterThanOrEqual(Math.max(v.mrr, l.mrr));
    expect(h.hit1).toBeGreaterThanOrEqual(Math.max(v.hit1, l.hit1));
    await db.close();
  });
});

describe('client disconnect over a real HTTP connection', () => {
  it('aborts the model call and bills only what was generated', async () => {
    const emb = new LocalEmbedder();
    const db = await freshDb(emb, true);
    const llm = new ScriptedLlm('word '.repeat(2000) + '[1]');
    const app = await buildApp({ db, embedder: emb, llm, cfg: testConfig({ RATE_LIMIT_PER_MIN: '1000' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;

    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-client-id': 'real-leaver' },
      body: JSON.stringify({ question: 'How long is parental leave?' }),
    });
    const reader = res.body!.getReader();
    let got = '';
    while (!/token/.test(got)) got += new TextDecoder().decode((await reader.read()).value); // hasta el primer token
    ac.abort(); // el usuario cierra la pestaña

    let row: any;
    for (let i = 0; i < 100 && !row; i++) {
      await new Promise((r) => setTimeout(r, 30));
      row = (await db.tx((q) => q.query<any>(`SELECT outcome, output_tokens FROM usage_log WHERE client_id='real-leaver'`)))[0];
    }
    expect(row?.outcome).toBe('aborted');
    expect(row.output_tokens).toBeGreaterThan(0);
    expect(row.output_tokens).toBeLessThan(2000); // no se generó (ni se pagó) el resto de la respuesta
    await app.close();
    await db.close();
  });
});
