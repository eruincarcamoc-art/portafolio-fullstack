export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Dos formas de hablar con la base de datos:
 *  - admin():  rol propietario, ignora RLS. Solo para flujos sin tenant (registro, login, webhooks).
 *  - tenant(): `SET LOCAL ROLE tenantly_app` + `app.tenant_id`. RLS filtra TODO por tenant,
 *              aunque el código olvide un `WHERE tenant_id = ...`.
 * Ambas corren dentro de una transacción.
 */
export interface Db {
  admin<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  tenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const TENANT_ROLE = 'tenantly_app';

/** Ejecuta un `SELECT count(*) AS c ...` y devuelve el número. */
export async function countOf(q: Queryable, sql: string, params?: unknown[]): Promise<number> {
  const rows = await q.query<{ c: string }>(sql, params);
  return Number(rows[0]?.c ?? 0);
}
