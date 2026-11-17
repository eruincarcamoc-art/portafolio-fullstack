import { z } from 'zod';

const num = (d: number) => z.coerce.number().default(d);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: num(4300),
  /** Sin DATABASE_URL se usa PGlite + pgvector embebido (solo desarrollo). */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),

  // --- proveedores ---
  LLM_PROVIDER: z.enum(['local', 'anthropic']).default('local'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  EMBED_PROVIDER: z.enum(['local', 'voyage']).default('local'),
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_MODEL: z.string().default('voyage-3'),
  VOYAGE_DIMS: num(1024),

  // --- precios (USD por millón de tokens). Sin inventar cifras: configúralos con la tarifa vigente. ---
  PRICE_INPUT_PER_MTOK: num(0),
  PRICE_OUTPUT_PER_MTOK: num(0),

  // --- recuperación y respuesta ---
  RETRIEVAL_K: num(5),
  // Umbrales de la compuerta de confianza (calibrados con `npm run eval` para el embedder local; recalibrar al cambiar de modelo).
  MIN_SIMILARITY: num(0.25),
  MIN_COVERAGE: num(0.1),
  MAX_ANSWER_TOKENS: num(600),
  CACHE_SIMILARITY: num(0.96),
  CACHE_TTL_HOURS: num(24),

  // --- guardarraíles de coste y abuso ---
  RATE_LIMIT_PER_MIN: num(20),
  DAILY_TOKEN_BUDGET: num(200_000),
  MAX_QUESTION_CHARS: num(1000),
  ADMIN_TOKEN: z.string().optional(),
  ALLOWED_ORIGIN: z.string().default('*'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.LLM_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  if (cfg.EMBED_PROVIDER === 'voyage' && !cfg.VOYAGE_API_KEY) throw new Error('EMBED_PROVIDER=voyage requires VOYAGE_API_KEY');
  if (cfg.NODE_ENV === 'production' && !cfg.DATABASE_URL) throw new Error('DATABASE_URL is required in production');
  return cfg;
}
