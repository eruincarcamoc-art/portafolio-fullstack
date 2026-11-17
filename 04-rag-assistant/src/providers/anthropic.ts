import type { Config } from '../config.js';
import { CircuitBreaker, withRetry, type RetryOptions } from './resilience.js';
import { ProviderError, type Llm, type LlmEvent, type LlmRequest } from './types.js';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Tiempo máximo total de una respuesta. */
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  breaker?: CircuitBreaker;
}

/**
 * Cliente de la Messages API de Anthropic con streaming SSE, sin SDK (menos dependencias, fácil de testear).
 * - Reintenta SOLO la conexión (429/5xx/red) con backoff + jitter y `retry-after`; una vez que empiezan a
 *   llegar tokens ya no se reintenta (duplicaría texto y coste).
 * - Timeout total y cancelación por `signal`: si el usuario cierra la pestaña, se corta el stream.
 * - Cortacircuitos para no apilar peticiones contra un proveedor caído.
 */
export class AnthropicLlm implements Llm {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly breaker: CircuitBreaker;

  constructor(private readonly opts: AnthropicOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.breaker = opts.breaker ?? new CircuitBreaker();
  }

  static fromConfig(cfg: Config): AnthropicLlm {
    return new AnthropicLlm({ apiKey: cfg.ANTHROPIC_API_KEY!, model: cfg.ANTHROPIC_MODEL });
  }

  private async connect(req: LlmRequest, signal: AbortSignal): Promise<Response> {
    return this.breaker.run(() =>
      withRetry(
        async () => {
          let res: Response;
          try {
            res = await this.fetchImpl(`${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
              method: 'POST',
              signal,
              headers: {
                'content-type': 'application/json',
                'x-api-key': this.opts.apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: this.model,
                max_tokens: req.maxTokens,
                system: req.system,
                messages: req.messages,
                stream: true,
              }),
            });
          } catch (e) {
            if (signal.aborted) throw e;
            throw new ProviderError(`Network error: ${(e as Error).message}`, null, true);
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            const retryable = res.status === 429 || res.status >= 500;
            const err = new ProviderError(`Anthropic API ${res.status}: ${body.slice(0, 300)}`, res.status, retryable);
            const ra = Number(res.headers.get('retry-after'));
            if (ra > 0) (err as any).retryAfterMs = ra * 1000;
            throw err;
          }
          return res;
        },
        { retries: 3, baseMs: 500, capMs: 8000, ...this.opts.retry },
        signal,
      ),
    );
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(this.opts.timeoutMs ?? 60_000)])
      : AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
    const res = await this.connect(req, signal);
    if (!res.body) throw new ProviderError('Empty response body', res.status, false);

    let inputTokens = 0;
    let outputTokens = 0;
    for await (const ev of parseSse(res.body, signal)) {
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (ev.event ?? data.type) {
        case 'message_start':
          inputTokens = data.message?.usage?.input_tokens ?? 0;
          outputTokens = data.message?.usage?.output_tokens ?? 0;
          break;
        case 'content_block_delta':
          if (data.delta?.type === 'text_delta' && data.delta.text) yield { type: 'text', text: data.delta.text };
          break;
        case 'message_delta':
          if (data.usage?.output_tokens !== undefined) outputTokens = data.usage.output_tokens;
          break;
        case 'error':
          throw new ProviderError(`Stream error: ${data.error?.message ?? 'unknown'}`, null, data.error?.type === 'overloaded_error');
        case 'message_stop':
          yield { type: 'usage', inputTokens, outputTokens };
          return;
      }
    }
    // El stream terminó sin message_stop: devolvemos el uso conocido.
    yield { type: 'usage', inputTokens, outputTokens };
  }
}

/** Parser mínimo de Server-Sent Events sobre un ReadableStream. */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        let event: string | undefined;
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
