import type { Db } from './db.js';

export interface Prices {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const costUsd = (inputTokens: number, outputTokens: number, p: Prices): number =>
  (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;

export class BudgetExceeded extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Daily token budget exceeded (${used}/${limit}). Try again tomorrow.`);
  }
}

export class RateLimited extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`Too many requests. Retry in ${retryAfterSec}s.`);
  }
}

/** Presupuesto diario por cliente, contado desde `usage_log` (persistente y compartido entre instancias). */
export async function checkBudget(db: Db, clientId: string, limit: number, now = new Date()): Promise<number> {
  const used = await db.tx(async (q) =>
    Number(
      (await q.query<{ n: string }>(
        `SELECT COALESCE(sum(input_tokens + output_tokens), 0) AS n FROM usage_log WHERE client_id=$1 AND at > $2::timestamptz - interval '24 hours'`,
        [clientId, now],
      ))[0]!.n,
    ),
  );
  if (used >= limit) throw new BudgetExceeded(used, limit);
  return used;
}

/** Ventana deslizante en memoria (por instancia). Para varias instancias, moverlo a Redis. */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): void {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      throw new RateLimited(Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000)));
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
  }
}

export interface UsageRecord {
  clientId: string;
  kind: 'chat' | 'embed' | 'ingest';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  cached: boolean;
  outcome: 'ok' | 'refused' | 'error' | 'cache_hit' | 'aborted';
}

export async function logUsage(db: Db, u: UsageRecord): Promise<void> {
  await db.tx((q) =>
    q.query(
      `INSERT INTO usage_log(client_id, kind, model, input_tokens, output_tokens, cost_usd, latency_ms, cached, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [u.clientId, u.kind, u.model, u.inputTokens, u.outputTokens, u.costUsd, u.latencyMs, u.cached, u.outcome],
    ),
  );
}

export async function usageSummary(db: Db) {
  return db.tx(async (q) => {
    const totals = (await q.query<any>(
      `SELECT count(*) FILTER (WHERE kind='chat')::int AS requests,
              count(*) FILTER (WHERE outcome='cache_hit')::int AS "cacheHits",
              count(*) FILTER (WHERE outcome='refused')::int AS refusals,
              count(*) FILTER (WHERE outcome='error')::int AS errors,
              COALESCE(sum(input_tokens),0)::int AS "inputTokens",
              COALESCE(sum(output_tokens),0)::int AS "outputTokens",
              COALESCE(sum(cost_usd),0)::float AS "costUsd",
              COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE kind='chat'),0)::int AS "p50Ms",
              COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE kind='chat'),0)::int AS "p95Ms"
         FROM usage_log`,
    ))[0];
    return totals;
  });
}
