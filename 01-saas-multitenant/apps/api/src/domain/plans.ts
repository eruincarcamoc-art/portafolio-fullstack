export const PLAN_IDS = ['free', 'pro', 'business'] as const;
export type Plan = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  projects: number;
  members: number;
  auditRetentionDays: number;
}

export const PLANS: Record<Plan, { label: string; priceUsd: number; limits: PlanLimits }> = {
  free: { label: 'Free', priceUsd: 0, limits: { projects: 3, members: 3, auditRetentionDays: 7 } },
  pro: { label: 'Pro', priceUsd: 29, limits: { projects: 50, members: 15, auditRetentionDays: 90 } },
  business: {
    label: 'Business',
    priceUsd: 99,
    limits: { projects: Number.POSITIVE_INFINITY, members: Number.POSITIVE_INFINITY, auditRetentionDays: 365 },
  },
};

export const limitsOf = (plan: Plan): PlanLimits => PLANS[plan].limits;

/** Infinity no serializa en JSON: lo exponemos como null ("sin límite"). */
export const serializeLimit = (n: number): number | null => (Number.isFinite(n) ? n : null);
