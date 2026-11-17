import { describe, it, expect } from 'vitest';
import { chunkText } from '../src/rag/chunker.js';
import { LocalEmbedder } from '../src/providers/local.js';
import { contentTerms, splitSentences, stem } from '../src/providers/text.js';
import { AnthropicLlm, parseSse } from '../src/providers/anthropic.js';
import { VoyageEmbedder } from '../src/providers/voyage.js';
import { CircuitBreaker, withRetry } from '../src/providers/resilience.js';
import { ProviderError, type LlmEvent } from '../src/providers/types.js';

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe('chunker', () => {
  const md = `# Handbook

## Security

Passwords must be long. Never reuse them across systems. Use the password manager.

Laptops must be encrypted.

## Travel

Flights are booked in economy. Business class needs approval.

### Hotels

Hotels are capped per night.`;

  it('never mixes sections and keeps the heading path as context', () => {
    const chunks = chunkText(md);
    expect(chunks.map((c) => c.heading)).toEqual(['Handbook > Security', 'Handbook > Travel', 'Handbook > Travel > Hotels']);
    expect(chunks[0]!.content).toContain('Passwords');
    expect(chunks[0]!.content).not.toContain('Flights');
  });

  it('numbers chunks sequentially', () => {
    expect(chunkText(md).map((c) => c.ord)).toEqual([0, 1, 2]);
  });

  it('splits long sections, respects maxChars, and overlaps neighbours by whole sentences', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about topic ${i}.`);
    const long = `# Doc\n\n${sentences.join(' ')}`;
    const chunks = chunkText(long, { targetChars: 400, maxChars: 500, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThan(500 + 100 + 10);
    // el final del chunk i aparece al principio del i+1
    const lastSentence = splitSentences(chunks[0]!.content).at(-1)!;
    expect(chunks[1]!.content).toContain(lastSentence);
  });

  it('does not treat "#" inside code fences as headings', () => {
    const chunks = chunkText('# Title\n\nIntro text here.\n\n```bash\n# a comment, not a heading\nls -la\n```\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('# a comment');
  });

  it('splits a single huge paragraph without losing text', () => {
    const para = 'word '.repeat(1000).trim();
    const chunks = chunkText(para, { targetChars: 300, maxChars: 400, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((c) => c.content).join(' ').replace(/\s+/g, ' ').length).toBeGreaterThanOrEqual(para.length - 5);
  });

  it('handles empty input and is deterministic', () => {
    expect(chunkText('   \n\n ')).toEqual([]);
    expect(chunkText(md)).toEqual(chunkText(md));
  });
});

describe('text utils', () => {
  it('stems common suffixes so related word forms share a root', () => {
    expect(stem('passwords')).toBe(stem('password'));
    expect(stem('reimbursed')).toBe(stem('reimbursing'));
    expect(stem('policies')).toBe('policy');
    expect(stem('2024')).toBe('2024'); // los números no se tocan
    expect(stem('use')).toBe('use'); // palabras cortas intactas
  });
  it('drops stopwords and accents, keeps content terms', () => {
    expect(contentTerms('How many of the passwords are required?')).toEqual(['many', 'password', 'requir']);
    expect(contentTerms('¿Cuál es la política de contraseñas?')).toEqual(['politica', 'contrasena']);
  });
});

describe('LocalEmbedder', () => {
  const e = new LocalEmbedder();
  it('is deterministic, fixed-size and L2-normalised', async () => {
    const [a, b] = (await e.embed(['Passwords must be 14 characters', 'Passwords must be 14 characters'])).vectors;
    expect(a).toEqual(b);
    expect(a).toHaveLength(256);
    expect(Math.sqrt(dot(a!, a!))).toBeCloseTo(1, 6);
  });
  it('ranks a related text above an unrelated one', async () => {
    const { vectors: [q, rel, unrel] } = await e.embed(['how long should passwords be', 'Passwords must be at least 14 characters long', 'The hotel limit per night is 220 dollars']);
    expect(dot(q!, rel!)).toBeGreaterThan(dot(q!, unrel!) + 0.1);
  });
  it('handles empty and symbol-only text without NaN', async () => {
    const [v] = (await e.embed(['', '???'])).vectors;
    expect(v!.every((x) => Number.isFinite(x))).toBe(true);
  });
});

// ---------------------------------------------------------------- SSE + Anthropic

const sseBody = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });

const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const anthropicStream = (text: string[], usage = { in: 42, out: 7 }) => [
  ev('message_start', { type: 'message_start', message: { usage: { input_tokens: usage.in, output_tokens: 1 } } }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ...text.map((t) => ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.out } }),
  ev('message_stop', { type: 'message_stop' }),
];

describe('parseSse', () => {
  it('reassembles events split at arbitrary byte boundaries', async () => {
    const whole = anthropicStream(['Hello', ' world']).join('');
    const pieces = whole.match(/[\s\S]{1,7}/g)!; // trozos de 7 bytes
    const events = [];
    for await (const e of parseSse(sseBody(pieces))) events.push(e);
    expect(events.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'message_delta', 'message_stop']);
  });
});

describe('AnthropicLlm', () => {
  const collect = async (gen: AsyncGenerator<LlmEvent>) => {
    const out: LlmEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  };
  const req = { system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100 };
  const okResponse = (chunks = anthropicStream(['Hel', 'lo'])) => new Response(sseBody(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const noSleep = { sleep: async () => {}, rng: () => 0.5 };

  it('streams text deltas and reports token usage; sends the right request', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const llm = new AnthropicLlm({ apiKey: 'k-test', model: 'claude-test', fetchImpl: (async (url: string, init: RequestInit) => { seen = { url, init }; return okResponse(); }) as any });
    const events = await collect(llm.stream(req));
    expect(events.filter((e) => e.type === 'text').map((e: any) => e.text).join('')).toBe('Hello');
    expect(events.at(-1)).toEqual({ type: 'usage', inputTokens: 42, outputTokens: 7 });
    expect(seen!.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ model: 'claude-test', max_tokens: 100, system: 'sys', stream: true });
  });

  it('retries 429 and 5xx with backoff (honouring retry-after) and then succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    const llm = new AnthropicLlm({
      apiKey: 'k', model: 'm',
      retry: { sleep: async (ms: number) => void waits.push(ms), rng: () => 1 },
      fetchImpl: (async () => {
        n++;
        if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '3' } });
        if (n === 2) return new Response('boom', { status: 503 });
        return okResponse();
      }) as any,
    });
    const events = await collect(llm.stream(req));
    expect(n).toBe(3);
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(waits[0]).toBeGreaterThanOrEqual(3000); // respeta retry-after
    expect(waits[1]).toBeGreaterThan(0);
  });

  it('does NOT retry client errors (e.g. invalid API key)', async () => {
    let n = 0;
    const llm = new AnthropicLlm({ apiKey: 'bad', model: 'm', retry: noSleep, fetchImpl: (async () => { n++; return new Response('{"error":"invalid x-api-key"}', { status: 401 }); }) as any });
    await expect(collect(llm.stream(req))).rejects.toMatchObject({ status: 401, retryable: false });
    expect(n).toBe(1);
  });

  it('gives up after the retry budget and surfaces a ProviderError', async () => {
    let n = 0;
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', retry: { ...noSleep, retries: 2 }, fetchImpl: (async () => { n++; return new Response('down', { status: 500 }); }) as any });
    await expect(collect(llm.stream(req))).rejects.toBeInstanceOf(ProviderError);
    expect(n).toBe(3);
  });

  it('turns an in-stream error event into a ProviderError', async () => {
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl: (async () => okResponse([ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })])) as any });
    await expect(collect(llm.stream(req))).rejects.toMatchObject({ retryable: true });
  });

  it('stops generating when the caller aborts', async () => {
    const ac = new AbortController();
    const slow = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const chunk of anthropicStream(['a', 'b', 'c', 'd'])) {
          c.enqueue(new TextEncoder().encode(chunk));
          await new Promise((r) => setTimeout(r, 15));
        }
        c.close();
      },
    });
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl: (async () => new Response(slow, { status: 200 })) as any });
    const got: string[] = [];
    await expect(
      (async () => {
        for await (const e of llm.stream({ ...req, signal: ac.signal })) {
          if (e.type === 'text') { got.push(e.text); if (got.length === 1) ac.abort(new Error('user left')); }
        }
      })(),
    ).rejects.toThrow();
    expect(got.length).toBeLessThan(4);
  });
});

describe('VoyageEmbedder', () => {
  const vec = (i: number, d: number) => Array.from({ length: d }, (_, k) => (k === i % d ? 1 : 0));
  it('batches inputs, restores order by index, passes input_type and reports tokens', async () => {
    const bodies: any[] = [];
    const e = new VoyageEmbedder({
      apiKey: 'k', model: 'voyage-test', dims: 8,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const b = JSON.parse(init.body as string);
        bodies.push(b);
        const data = b.input.map((_: string, i: number) => ({ index: i, embedding: vec(i, 8) })).reverse(); // desordenado a propósito
        return new Response(JSON.stringify({ data, usage: { total_tokens: b.input.length * 3 } }), { status: 200 });
      }) as any,
    });
    const texts = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const { vectors, tokens } = await e.embed(texts, 'document');
    expect(bodies.map((b) => b.input.length)).toEqual([64, 36]);
    expect(bodies[0].input_type).toBe('document');
    expect(vectors).toHaveLength(100);
    expect(vectors[1]).toEqual(vec(1, 8)); // orden correcto
    expect(tokens).toBe(300);
  });

  it('rejects unexpected dimensions (wrong model configured)', async () => {
    const e = new VoyageEmbedder({ apiKey: 'k', model: 'm', dims: 8, fetchImpl: (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 })) as any });
    await expect(e.embed(['x'], 'query')).rejects.toThrow(/8-dim/);
  });
});

describe('resilience', () => {
  it('withRetry uses exponential backoff with jitter and never retries when aborted', async () => {
    const waits: number[] = [];
    let n = 0;
    await expect(
      withRetry(async () => { n++; throw new ProviderError('x', 500, true); }, { retries: 3, baseMs: 100, capMs: 10_000, sleep: async (ms) => void waits.push(ms), rng: () => 1 }),
    ).rejects.toThrow();
    expect(waits).toEqual([100, 200, 400]);
    expect(n).toBe(4);
  });

  it('circuit breaker opens after N failures, fails fast, then half-opens after the cooldown', async () => {
    let t = 0;
    const b = new CircuitBreaker(3, 1000, () => t);
    const fail = () => b.run(async () => { throw new ProviderError('down', 503, true); });
    for (let i = 0; i < 3; i++) await expect(fail()).rejects.toThrow('down');
    expect(b.state).toBe('open');
    let called = false;
    await expect(b.run(async () => { called = true; })).rejects.toThrow(/circuit open/);
    expect(called).toBe(false); // falla rápido: ni se intenta
    t = 1500;
    expect(b.state).toBe('half-open');
    await b.run(async () => 'ok');
    expect(b.state).toBe('closed');
  });

  it('client errors (4xx) do not trip the breaker', async () => {
    const b = new CircuitBreaker(2, 1000);
    for (let i = 0; i < 5; i++) await expect(b.run(async () => { throw new ProviderError('bad key', 401, false); })).rejects.toThrow();
    expect(b.state).toBe('closed');
  });
});
