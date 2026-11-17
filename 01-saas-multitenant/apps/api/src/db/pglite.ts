import { PGlite } from '@electric-sql/pglite';
import { Db, Queryable, TENANT_ROLE } from './types.js';

/** Postgres real (WASM) en proceso: mismo SQL, mismo RLS. Usado en tests y en dev sin Docker. */
export function createPgliteDb(dataDir?: string): Db {
  const db = new PGlite(dataDir);

  type Tx = {
    query: (s: string, p?: any[]) => Promise<{ rows: any[] }>;
    exec: (s: string) => Promise<{ rows: any[] }[]>;
  };
  // Sin parámetros usamos exec() (permite varias sentencias, p. ej. migraciones); con parámetros, query().
  const wrap = (tx: Tx): Queryable => ({
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const res = await tx.exec(sql);
        return res[res.length - 1]?.rows ?? [];
      }
      return (await tx.query(sql, params as any[])).rows;
    },
  });

  return {
    admin: (fn) => db.transaction((tx) => fn(wrap(tx as any))),
    tenant: (tenantId, fn) =>
      db.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${TENANT_ROLE}`);
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        return fn(wrap(tx as any));
      }),
    close: () => db.close(),
  };
}
