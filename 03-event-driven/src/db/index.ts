import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Todas las operaciones corren dentro de una transacción. */
export interface Db {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  return {
    async tx(fn) {
      const client = await pool.connect();
      const q: Queryable = { query: async (sql, params) => (await client.query(sql, params as any[])).rows };
      try {
        await client.query('BEGIN');
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Postgres real compilado a WASM: mismo SQL (incluido FOR UPDATE SKIP LOCKED) sin servicios externos. */
export function createPgliteDb(dataDir?: string): Db {
  const db = new PGlite(dataDir);
  const wrap = (tx: any): Queryable => ({
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const res = await tx.exec(sql); // permite varias sentencias (migraciones)
        return res[res.length - 1]?.rows ?? [];
      }
      return (await tx.query(sql, params)).rows;
    },
  });
  return {
    tx: (fn) => db.transaction((tx) => fn(wrap(tx))),
    close: () => db.close(),
  };
}

export async function countOf(q: Queryable, sql: string, params?: unknown[]): Promise<number> {
  const rows = await q.query<{ c: string }>(sql, params);
  return Number(rows[0]?.c ?? 0);
}
