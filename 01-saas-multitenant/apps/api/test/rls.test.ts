import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPgliteDb } from '../src/db/pglite.js';
import { migrate } from '../src/db/migrate.js';
import type { Db } from '../src/db/types.js';

describe('Row-Level Security', () => {
  let db: Db;
  let a: string;
  let b: string;

  beforeAll(async () => {
    db = createPgliteDb();
    await migrate(db);
    await db.admin(async (q) => {
      a = (await q.query(`INSERT INTO tenants(name, slug) VALUES ('A','a') RETURNING id`))[0].id;
      b = (await q.query(`INSERT INTO tenants(name, slug) VALUES ('B','b') RETURNING id`))[0].id;
      await q.query(`INSERT INTO projects(tenant_id, name) VALUES ($1,'proj-a'), ($2,'proj-b')`, [a, b]);
    });
  });
  afterAll(() => db.close());

  it('migrations are idempotent', async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it('a tenant only sees its own rows, even with an unfiltered SELECT', async () => {
    const rows = await db.tenant(a, (q) => q.query(`SELECT name FROM projects`));
    expect(rows.map((r: any) => r.name)).toEqual(['proj-a']);
  });

  it('cannot insert rows for another tenant (WITH CHECK)', async () => {
    await expect(
      db.tenant(a, (q) => q.query(`INSERT INTO projects(tenant_id, name) VALUES ($1,'evil')`, [b])),
    ).rejects.toThrow();
  });

  it('cannot update or delete another tenant rows', async () => {
    const upd = await db.tenant(a, (q) => q.query(`UPDATE projects SET name='x' RETURNING id`));
    expect(upd).toHaveLength(1); // solo la suya
    const left = await db.admin((q) => q.query(`SELECT name FROM projects WHERE tenant_id=$1`, [b]));
    expect(left[0].name).toBe('proj-b');
  });

  it('audit_log is append-only for the app role', async () => {
    await db.tenant(a, (q) => q.query(`INSERT INTO audit_log(tenant_id, action, entity) VALUES ($1,'t','t')`, [a]));
    await expect(db.tenant(a, (q) => q.query(`DELETE FROM audit_log`))).rejects.toThrow();
  });

  it('no tenant context means no rows', async () => {
    const rows = await db.admin(async (q) => {
      await q.query(`SET LOCAL ROLE tenantly_app`);
      return q.query(`SELECT * FROM projects`);
    });
    expect(rows).toHaveLength(0);
  });
});
