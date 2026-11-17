import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { Queryable } from '../db/types.js';
import { conflict, unauthorized } from '../errors.js';
import { parse, requireAuth } from '../http.js';
import { hashToken, randomToken, slugify } from '../domain/security.js';
import { audit } from '../domain/audit.js';

const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
// Hash ficticio: login tarda lo mismo exista o no el usuario (evita enumeración por timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const registerSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100),
  workspaceName: z.string().trim().min(1).max(60),
});
const loginSchema = z.object({ email: z.string().email().transform((s) => s.toLowerCase()), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });

async function issueTokens(app: FastifyInstance, q: Queryable, userId: string) {
  const refreshToken = randomToken();
  await q.query(`INSERT INTO refresh_tokens(user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, [
    userId,
    hashToken(refreshToken),
    new Date(Date.now() + REFRESH_TTL_MS),
  ]);
  return { accessToken: app.jwt.sign({ sub: userId }), refreshToken };
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', authLimit, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const passwordHash = await bcrypt.hash(body.password, 10);

    const result = await app.db.admin(async (q) => {
      const exists = await q.query(`SELECT 1 FROM users WHERE email=$1`, [body.email]);
      if (exists.length) throw conflict('Email already registered');

      const user = (
        await q.query(`INSERT INTO users(email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name`, [
          body.email,
          passwordHash,
          body.name,
        ])
      )[0];
      const slug = `${slugify(body.workspaceName)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
      const tenant = (
        await q.query(`INSERT INTO tenants(name, slug) VALUES ($1,$2) RETURNING id, name, slug, plan`, [
          body.workspaceName,
          slug,
        ])
      )[0];
      await q.query(`INSERT INTO memberships(tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [tenant.id, user.id]);
      await audit(q, { tenantId: tenant.id, actorId: user.id, action: 'tenant.created', entity: 'tenant', entityId: tenant.id });
      const tokens = await issueTokens(app, q, user.id);
      return { user, tenant, ...tokens };
    });
    return reply.status(201).send(result);
  });

  app.post('/auth/login', authLimit, async (req) => {
    const body = parse(loginSchema, req.body);
    return app.db.admin(async (q) => {
      const user = (await q.query(`SELECT id, email, name, password_hash FROM users WHERE email=$1`, [body.email]))[0];
      const ok = await bcrypt.compare(body.password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok) throw unauthorized('Invalid email or password');
      const tokens = await issueTokens(app, q, user.id);
      return { user: { id: user.id, email: user.email, name: user.name }, ...tokens };
    });
  });

  // Rotación de refresh tokens con detección de reutilización.
  app.post('/auth/refresh', authLimit, async (req) => {
    const { refreshToken } = parse(refreshSchema, req.body);
    // Fuera de la transacción de revocación: si detectamos reuso, el REVOKE debe persistir.
    const outcome = await app.db.admin(async (q) => {
      const row = (
        await q.query(`SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE`, [
          hashToken(refreshToken),
        ])
      )[0];
      if (!row) return { kind: 'invalid' as const };
      if (row.revoked_at) {
        await q.query(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [row.user_id]);
        return { kind: 'reuse' as const };
      }
      if (new Date(row.expires_at) < new Date()) return { kind: 'invalid' as const };
      await q.query(`UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1`, [row.id]);
      return { kind: 'ok' as const, tokens: await issueTokens(app, q, row.user_id) };
    });
    if (outcome.kind !== 'ok') throw unauthorized('Invalid refresh token');
    return outcome.tokens;
  });

  app.post('/auth/logout', async (req, reply) => {
    const { refreshToken } = parse(refreshSchema, req.body);
    await app.db.admin((q) =>
      q.query(`UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, [
        hashToken(refreshToken),
      ]),
    );
    return reply.status(204).send();
  });

  app.get('/me', async (req) => {
    const userId = await requireAuth(req);
    return app.db.admin(async (q) => {
      const user = (await q.query(`SELECT id, email, name FROM users WHERE id=$1`, [userId]))[0];
      if (!user) throw unauthorized();
      const tenants = await q.query(
        `SELECT t.id, t.name, t.slug, t.plan, m.role
           FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id=$1 ORDER BY t.created_at`,
        [userId],
      );
      return { user, tenants };
    });
  });
}
