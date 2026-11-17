import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPgliteDb } from '../src/db/pglite.js';
import { migrate } from '../src/db/migrate.js';
import type { Db } from '../src/db/types.js';

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  cfg: Config;
  close(): Promise<void>;
}

export async function makeApp(env: Record<string, string> = {}): Promise<TestCtx> {
  const cfg = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'test-secret-test-secret', ...env } as any);
  const db = createPgliteDb();
  await migrate(db);
  const app = await buildApp({ config: cfg, db, rateLimit: false, logger: false });
  await app.ready();
  return {
    app,
    db,
    cfg,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export interface Session {
  userId: string;
  tenantId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

let counter = 0;
export async function register(app: FastifyInstance, name = 'User'): Promise<Session> {
  const email = `user${++counter}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'correct-horse-battery', name, workspaceName: `${name} Workspace` },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const b = res.json();
  return { userId: b.user.id, tenantId: b.tenant.id, email, accessToken: b.accessToken, refreshToken: b.refreshToken };
}

export const authHeaders = (s: Pick<Session, 'accessToken'>, tenantId?: string) => ({
  authorization: `Bearer ${s.accessToken}`,
  ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
});

/** Atajo: petición autenticada contra el workspace `tenantId`. */
export const call = (app: FastifyInstance, s: Session, tenantId: string) => (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url: `/api${url}`, headers: authHeaders(s, tenantId), payload: payload as any });

/** Invita y acepta: deja a `invitee` como miembro de `owner.tenantId` con el rol indicado. */
export async function addMember(app: FastifyInstance, owner: Session, invitee: Session, role: 'admin' | 'member' | 'viewer') {
  const inv = await call(app, owner, owner.tenantId)('POST', '/t/invitations', { email: invitee.email, role });
  if (inv.statusCode !== 201) throw new Error(`invite failed: ${inv.body}`);
  const acc = await app.inject({
    method: 'POST',
    url: '/api/invitations/accept',
    headers: authHeaders(invitee),
    payload: { token: inv.json().token },
  });
  if (acc.statusCode !== 200) throw new Error(`accept failed: ${acc.body}`);
}
