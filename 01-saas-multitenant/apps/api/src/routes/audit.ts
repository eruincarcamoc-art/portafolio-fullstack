import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, tenantRoute } from '../http.js';
import { limitsOf } from '../domain/plans.js';

const schema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Paginación por cursor (keyset): estable aunque se inserten filas nuevas. */
  before: z.coerce.number().int().positive().optional(),
});

export async function auditRoutes(app: FastifyInstance) {
  app.get(
    '/t/audit',
    tenantRoute(app, 'audit:read', async ({ q, req, tenant }) => {
      const f = parse(schema, req.query);
      const days = limitsOf(tenant.plan).auditRetentionDays; // la retención depende del plan
      const rows = await q.query(
        `SELECT a.id, a.action, a.entity, a.entity_id, a.meta, a.created_at, u.name AS actor_name, u.email AS actor_email
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.created_at > now() - make_interval(days => $1)
            AND ($2::bigint IS NULL OR a.id < $2)
          ORDER BY a.id DESC LIMIT $3`,
        [days, f.before ?? null, f.limit + 1],
      );
      const hasMore = rows.length > f.limit;
      const items = rows.slice(0, f.limit);
      return { items, nextBefore: hasMore ? items[items.length - 1].id : null, retentionDays: days };
    }),
  );
}
