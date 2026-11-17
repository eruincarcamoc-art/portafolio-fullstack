import pg from 'pg';
import { Db, Queryable, TENANT_ROLE } from './types.js';

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });

  async function run<T>(setup: ((q: Queryable) => Promise<void>) | null, fn: (q: Queryable) => Promise<T>) {
    const client = await pool.connect();
    const q: Queryable = { query: async (sql, params) => (await client.query(sql, params as any[])).rows };
    try {
      await client.query('BEGIN');
      if (setup) await setup(q);
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    admin: (fn) => run(null, fn),
    tenant: (tenantId, fn) =>
      run(async (q) => {
        await q.query(`SET LOCAL ROLE ${TENANT_ROLE}`);
        await q.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      }, fn),
    close: () => pool.end(),
  };
}
