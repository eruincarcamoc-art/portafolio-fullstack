import { Db } from './types.js';
import { migrations } from './migrations.js';

export async function migrate(db: Db): Promise<string[]> {
  return db.admin(async (q) => {
    await q.query(
      `CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    // Evita carreras entre varias instancias arrancando a la vez.
    await q.query(`SELECT pg_advisory_xact_lock(727274)`);
    const done = new Set((await q.query<{ id: string }>(`SELECT id FROM _migrations`)).map((r) => r.id));
    const applied: string[] = [];
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await q.query(m.sql);
      await q.query(`INSERT INTO _migrations(id) VALUES ($1)`, [m.id]);
      applied.push(m.id);
    }
    return applied;
  });
}
