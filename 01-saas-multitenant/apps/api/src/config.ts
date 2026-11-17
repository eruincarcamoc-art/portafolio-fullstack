import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  /** Si falta, se usa PGlite (Postgres embebido) -> `npm run dev` funciona sin Docker. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET === 'dev-only-secret-change-me-please') {
      throw new Error('JWT_SECRET must be set in production');
    }
    if (!cfg.DATABASE_URL) throw new Error('DATABASE_URL must be set in production');
  }
  return cfg;
}
