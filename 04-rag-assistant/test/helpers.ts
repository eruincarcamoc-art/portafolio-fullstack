import { loadConfig, type Config } from '../src/config.js';
import { createPgliteDb, migrate, type Db } from '../src/db.js';
import { LocalEmbedder, LocalLlm } from '../src/providers/local.js';
import type { Embedder, Llm, LlmEvent, LlmRequest } from '../src/providers/types.js';
import { indexCorpus } from '../src/eval/run.js';

export const testConfig = (env: Record<string, string> = {}): Config => loadConfig({ NODE_ENV: 'test', ...env } as any);

export async function freshDb(embedder: Embedder = new LocalEmbedder(), withCorpus = false): Promise<Db> {
  const db = createPgliteDb();
  await migrate(db, embedder.dims);
  if (withCorpus) await indexCorpus(db, embedder, 'corpus');
  return db;
}

/** Cuenta cuántas veces se llama al embedder (los embeddings cuestan dinero). */
export class CountingEmbedder extends LocalEmbedder {
  calls: Array<{ n: number; kind: string }> = [];
  override async embed(texts: string[], kind: 'document' | 'query') {
    this.calls.push({ n: texts.length, kind });
    return super.embed(texts);
  }
}

/** LLM de guion: responde lo que se le diga y registra los prompts recibidos. */
export class ScriptedLlm implements Llm {
  readonly name = 'scripted';
  readonly model = 'scripted-model';
  requests: LlmRequest[] = [];
  constructor(
    private readonly reply: string | ((req: LlmRequest) => string) = 'Answer [1]',
    private readonly usage = { inputTokens: 100, outputTokens: 20 },
    private readonly failAfter: number | null = null,
  ) {}

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    this.requests.push(req);
    const text = typeof this.reply === 'function' ? this.reply(req) : this.reply;
    const parts = text.match(/\S+\s*/g) ?? [text];
    for (const [i, p] of parts.entries()) {
      if (req.signal?.aborted) return;
      if (this.failAfter !== null && i === this.failAfter) throw new Error('upstream exploded');
      yield { type: 'text', text: p };
      await new Promise((r) => setTimeout(r, 1));
    }
    yield { type: 'usage', ...this.usage };
  }
}

export { LocalEmbedder, LocalLlm };
