import type { Config } from '../config.js';
import { CircuitBreaker, withRetry, type RetryOptions } from './resilience.js';
import { ProviderError, type EmbedKind, type Embedder } from './types.js';

export interface VoyageOptions {
  apiKey: string;
  model: string;
  dims: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  retry?: Partial<RetryOptions>;
  breaker?: CircuitBreaker;
}

/** Embeddings de Voyage AI (el proveedor de embeddings que recomienda Anthropic). */
export class VoyageEmbedder implements Embedder {
  readonly name: string;
  readonly dims: number;
  private readonly fetchImpl: typeof fetch;
  private readonly breaker: CircuitBreaker;

  constructor(private readonly opts: VoyageOptions) {
    this.name = `voyage:${opts.model}`;
    this.dims = opts.dims;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.breaker = opts.breaker ?? new CircuitBreaker();
  }

  static fromConfig(cfg: Config): VoyageEmbedder {
    return new VoyageEmbedder({ apiKey: cfg.VOYAGE_API_KEY!, model: cfg.VOYAGE_MODEL, dims: cfg.VOYAGE_DIMS });
  }

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal) {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const json: any = await this.breaker.run(() =>
        withRetry(async () => {
          let res: Response;
          try {
            res = await this.fetchImpl(`${this.opts.baseUrl ?? 'https://api.voyageai.com'}/v1/embeddings`, {
              method: 'POST',
              signal: signal ?? AbortSignal.timeout(30_000),
              headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
              body: JSON.stringify({ input: batch, model: this.opts.model, input_type: kind }),
            });
          } catch (e) {
            throw new ProviderError(`Network error: ${(e as Error).message}`, null, true);
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new ProviderError(`Voyage API ${res.status}: ${body.slice(0, 200)}`, res.status, res.status === 429 || res.status >= 500);
          }
          return res.json();
        }, { retries: 3, baseMs: 500, capMs: 8000, ...this.opts.retry }, signal),
      );
      const data = [...(json.data as Array<{ index: number; embedding: number[] }>)].sort((a, b) => a.index - b.index);
      if (data.length !== batch.length) throw new ProviderError('Voyage returned an unexpected number of embeddings', 200, false);
      for (const d of data) {
        if (d.embedding.length !== this.dims) throw new ProviderError(`Expected ${this.dims}-dim embeddings, got ${d.embedding.length}`, 200, false);
        vectors.push(d.embedding);
      }
      tokens += json.usage?.total_tokens ?? 0;
    }
    return { vectors, tokens };
  }
}
