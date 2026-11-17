import type { Queryable } from '../db/types.js';

export interface AuditEntry {
  tenantId: string;
  actorId: string | null;
  action: string; // p. ej. "project.created"
  entity: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

/** Se escribe en la MISMA transacción que el cambio: o ocurren ambos o ninguno. */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_log(tenant_id, actor_id, action, entity, entity_id, meta) VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.tenantId, e.actorId, e.action, e.entity, e.entityId ?? null, JSON.stringify(e.meta ?? {})],
  );
}
