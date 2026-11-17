export type EmbedKind = 'document' | 'query';

export interface Embedder {
  readonly name: string;
  readonly dims: number;
  /** `kind` importa: modelos como Voyage/Cohere usan prefijos distintos para documentos y consultas. */
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<{ vectors: number[][]; tokens: number }>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number };

export interface Llm {
  readonly name: string;
  readonly model: string;
  /** Genera la respuesta en streaming. Cancelable con `signal` (cliente desconectado => no se paga el resto). */
  stream(req: LlmRequest): AsyncGenerator<LlmEvent>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** ~4 caracteres por token: estimación para proveedores que no devuelven uso. */
export const estimateTokens = (s: string): number => Math.max(1, Math.ceil(s.length / 4));
