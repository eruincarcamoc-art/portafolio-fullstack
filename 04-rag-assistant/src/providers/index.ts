import type { Config } from '../config.js';
import { AnthropicLlm } from './anthropic.js';
import { LocalEmbedder, LocalLlm } from './local.js';
import { VoyageEmbedder } from './voyage.js';
import type { Embedder, Llm } from './types.js';

export function createEmbedder(cfg: Config): Embedder {
  return cfg.EMBED_PROVIDER === 'voyage' ? VoyageEmbedder.fromConfig(cfg) : new LocalEmbedder();
}

export function createLlm(cfg: Config): Llm {
  return cfg.LLM_PROVIDER === 'anthropic' ? AnthropicLlm.fromConfig(cfg) : new LocalLlm();
}

export * from './types.js';
