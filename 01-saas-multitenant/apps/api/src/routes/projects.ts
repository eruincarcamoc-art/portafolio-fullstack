import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, paymentRequired } from '../errors.js';
import { countOf } from '../db/types.js';
import { parse, tenantRoute } from '../http.js';
import { limitsOf } from '../domain/plans.js';
import { audit } from '../domain/audit.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
});
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000),
    status: z.enum(['active', 'archived']),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');
const listSchema = z.object({
  status: z.enum(['active', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
const idSchema = z.object({ id: z.string().uuid() });

export async function projectRoutes(app: FastifyInstance) {
  app.get(
    '/t/projects',
    tenantRoute(app, 'project:read', async ({ q, req }) => {
      const f = parse(listSchema, req.query);
      // RLS ya limita al tenant: no hace falta (ni conviene) repetir WHERE tenant_id.
      const items = await q.query(
        `SELECT id, name, description, status, created_by, created_at, updated_at
           FROM projects WHERE ($1::text IS NULL OR status = $1)
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [f.status ?? null, f.limit, f.offset],
      );
      const total = await countOf(q, `SELECT count(*) AS c FROM projects WHERE ($1::text IS NULL OR status = $1)`, [f.status ?? null]);
      return { items, total, limit: f.limit, offset: f.offset };
    }),
  );

  app.post(
    '/t/projects',
    tenantRoute(app, 'project:write', async ({ q, req, reply, tenant, tenantId, userId }) => {
      const body = parse(createSchema, req.body);
      // Bloqueo de fila del tenant: serializa creaciones concurrentes para que el límite del plan no se pueda saltar.
      await q.query(`SELECT id FROM tenants FOR UPDATE`);
      const limit = limitsOf(tenant.plan).projects;
      const active = await countOf(q, `SELECT count(*) AS c FROM projects WHERE status='active'`);
      if (active >= limit) {
        throw paymentRequired(`Your ${tenant.plan} plan allows up to ${limit} active projects. Upgrade to add more.`);
      }
      const project = (
        await q.query(
          `INSERT INTO projects(tenant_id, name, description, created_by) VALUES ($1,$2,$3,$4)
           RETURNING id, name, description, status, created_by, created_at, updated_at`,
          [tenantId, body.name, body.description, userId],
        )
      )[0];
      await audit(q, { tenantId, actorId: userId, action: 'project.created', entity: 'project', entityId: project.id, meta: { name: body.name } });
      reply.status(201);
      return project;
    }),
  );

  app.get(
    '/t/projects/:id',
    tenantRoute(app, 'project:read', async ({ q, req }) => {
      const { id } = parse(idSchema, req.params);
      const p = (await q.query(`SELECT id, name, description, status, created_by, created_at, updated_at FROM projects WHERE id=$1`, [id]))[0];
      if (!p) throw notFound('Project not found');
      return p;
    }),
  );

  app.patch(
    '/t/projects/:id',
    tenantRoute(app, 'project:write', async ({ q, req, tenant, tenantId, userId }) => {
      const { id } = parse(idSchema, req.params);
      const body = parse(patchSchema, req.body);
      if (body.status === 'active') {
        await q.query(`SELECT id FROM tenants FOR UPDATE`);
        const active = await countOf(q, `SELECT count(*) AS c FROM projects WHERE status='active' AND id<>$1`, [id]);
        if (active >= limitsOf(tenant.plan).projects) throw paymentRequired('Active project limit reached for your plan.');
      }
      const p = (
        await q.query(
          `UPDATE projects SET name=COALESCE($2,name), description=COALESCE($3,description), status=COALESCE($4,status), updated_at=now()
            WHERE id=$1 RETURNING id, name, description, status, created_by, created_at, updated_at`,
          [id, body.name ?? null, body.description ?? null, body.status ?? null],
        )
      )[0];
      if (!p) throw notFound('Project not found');
      await audit(q, { tenantId, actorId: userId, action: 'project.updated', entity: 'project', entityId: id, meta: body });
      return p;
    }),
  );

  app.delete(
    '/t/projects/:id',
    tenantRoute(app, 'project:delete', async ({ q, req, reply, tenantId, userId }) => {
      const { id } = parse(idSchema, req.params);
      const deleted = await q.query(`DELETE FROM projects WHERE id=$1 RETURNING name`, [id]);
      if (!deleted.length) throw notFound('Project not found');
      await audit(q, { tenantId, actorId: userId, action: 'project.deleted', entity: 'project', entityId: id, meta: { name: deleted[0].name } });
      reply.status(204);
      return null;
    }),
  );
}
