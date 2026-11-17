import { z } from 'zod';

const num = (d: number) => z.coerce.number().default(d);
const bool = (d: boolean) => z.enum(['true', 'false']).default(d ? 'true' : 'false').transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: num(4400),
  DB_PATH: z.string().default('./data/pulse.db'),
  API_KEY: z.string().optional(),

  // Retención por resolución: datos finos poco tiempo, agregados gruesos mucho tiempo.
  RETENTION_10S_HOURS: num(6),
  RETENTION_1M_DAYS: num(14),
  RETENTION_1H_DAYS: num(400),

  // Protección de la ingesta
  MAX_SERIES_PER_METRIC: num(2000),
  MAX_SERIES_TOTAL: num(50_000),
  MAX_PENDING_KEYS: num(200_000),
  MAX_BATCH_POINTS: num(10_000),
  FLUSH_MS: num(1000),
  FLUSH_AT_KEYS: num(20_000),
  FUTURE_SKEW_SECONDS: num(300),

  // Alertas / monitores
  EVAL_INTERVAL_SECONDS: num(10),
  ALLOW_PRIVATE_TARGETS: bool(false),
  SIMULATE: bool(false),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === 'production' && !cfg.API_KEY) throw new Error('API_KEY is required in production');
  return cfg;
}
