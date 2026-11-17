import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import type { Queryable } from './db/types.js';
import { badRequest, forbidden, unauthorized } from './errors.js';
import { can, type Permission, type Role } from './domain/rbac.js';
import type { Plan } from './domain/plans.js';

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

/** Exige un access token válido y expone `req.userId`. */
export async function requireAuth(req: FastifyRequest): Promise<string> {
  try {
    const payload = await req.jwtVerify<{ sub: string }>();
    return payload.sub;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  subscription_status: string;
  stripe_customer_id: string | null;
  current_period_end: string | null;
}

export interface TenantCtx {
  q: Queryable;
  req: FastifyRequest;
  reply: FastifyReply;
  tenant: TenantRow;
  tenantId: string;
  userId: string;
  role: Role;
}

const uuid = z.string().uuid();

/**
 * Construye un handler tenant-scoped. En UNA transacción con RLS activo:
 *   1. autentica al usuario,
 *   2. resuelve el tenant desde la cabecera `X-Tenant-Id`,
 *   3. comprueba que es miembro (si no, 403: RLS no le devuelve ninguna fila),
 *   4. comprueba el permiso RBAC,
 *   5. ejecuta el handler (y su escritura de auditoría) de forma atómica.
 */
export function tenantRoute<R>(app: FastifyInstance, permission: Permission, handler: (c: TenantCtx) => Promise<R>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<R> => {
    const userId = await requireAuth(req);
    const header = req.headers['x-tenant-id'];
    const parsed = uuid.safeParse(Array.isArray(header) ? header[0] : header);
    if (!parsed.success) throw badRequest('Missing or invalid X-Tenant-Id header');
    const tenantId = parsed.data;

    return app.db.tenant(tenantId, async (q) => {
      const membership = await q.query<{ role: Role }>(`SELECT role FROM memberships WHERE user_id = $1`, [userId]);
      const role = membership[0]?.role;
      if (!role) throw forbidden('You are not a member of this workspace');
      if (!can(role, permission)) throw forbidden(`Missing permission: ${permission}`);
      const tenants = await q.query<TenantRow>(`SELECT * FROM tenants`);
      return handler({ q, req, reply, tenant: tenants[0]!, tenantId, userId, role });
    });
  };
}
