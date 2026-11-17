import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db/types.js';
import { parse, requireAuth, tenantRoute } from '../http.js';
import { limitsOf, serializeLimit, type Plan } from '../domain/plans.js';
import { audit } from '../domain/audit.js';
import { randomToken, slugify } from '../domain/security.js';

export async function usageOf(q: Queryable) {
  const [r] = await q.query<{ projects: string; members: string; pending: string }>(
    `SELECT (SELECT count(*) FROM projects WHERE status='active') AS projects,
            (SELECT count(*) FROM memberships) AS members,
            (SELECT count(*) FROM invitations WHERE accepted_at IS NULL AND expires_at > now()) AS pending`,
  );
  return { projects: Number(r!.projects), members: Number(r!.members), pendingInvitations: Number(r!.pending) };
}

export function limitsPayload(plan: Plan) {
  const l = limitsOf(plan);
  return { projects: serializeLimit(l.projects), members: serializeLimit(l.members), auditRetentionDays: l.auditRetentionDays };
}

export async function tenantRoutes(app: FastifyInstance) {
  // Crear un workspace adicional para el usuario autenticado.
  app.post('/tenants', async (req, reply) => {
    const userId = await requireAuth(req);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    const tenant = await app.db.admin(async (q) => {
      const slug = `${slugify(name)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
      const t = (await q.query(`INSERT INTO tenants(name, slug) VALUES ($1,$2) RETURNING id, name, slug, plan`, [name, slug]))[0];
      await q.query(`INSERT INTO memberships(tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [t.id, userId]);
      await audit(q, { tenantId: t.id, actorId: userId, action: 'tenant.created', entity: 'tenant', entityId: t.id });
      return { ...t, role: 'owner' };
    });
    return reply.status(201).send(tenant);
  });

  // Resumen del workspace actual: plan, rol, uso y límites.
  app.get(
    '/t',
    tenantRoute(app, 'project:read', async ({ q, tenant, role }) => ({
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan, subscriptionStatus: tenant.subscription_status },
      role,
      usage: await usageOf(q),
      limits: limitsPayload(tenant.plan),
    })),
  );
}
