import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, forbidden, notFound, paymentRequired, unauthorized, badRequest } from '../errors.js';
import { parse, requireAuth, tenantRoute } from '../http.js';
import { canAssignRole, ROLES, type Role } from '../domain/rbac.js';
import { limitsOf } from '../domain/plans.js';
import { audit } from '../domain/audit.js';
import { hashToken, randomToken } from '../domain/security.js';
import { countOf } from '../db/types.js';
import { usageOf } from './tenants.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const inviteSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  role: z.enum(['admin', 'member', 'viewer']),
});
const roleSchema = z.object({ role: z.enum(ROLES) });
const userIdParam = z.object({ userId: z.string().uuid() });
const idParam = z.object({ id: z.string().uuid() });

export async function memberRoutes(app: FastifyInstance) {
  app.get(
    '/t/members',
    tenantRoute(app, 'member:read', async ({ q }) => {
      const members = await q.query(
        `SELECT u.id, u.email, u.name, m.role, m.created_at
           FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY m.created_at`,
      );
      const invitations = await q.query(
        `SELECT id, email, role, expires_at, created_at FROM invitations
          WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      );
      return { members, invitations };
    }),
  );

  app.patch(
    '/t/members/:userId',
    tenantRoute(app, 'member:manage', async ({ q, req, role: actor, tenantId, userId }) => {
      const { userId: targetId } = parse(userIdParam, req.params);
      const { role: newRole } = parse(roleSchema, req.body);
      const target = (await q.query<{ role: Role }>(`SELECT role FROM memberships WHERE user_id=$1 FOR UPDATE`, [targetId]))[0];
      if (!target) throw notFound('Member not found');
      if (!canAssignRole(actor, target.role, newRole)) throw forbidden('You cannot assign this role');
      if (target.role === 'owner' && newRole !== 'owner') {
        const owners = await countOf(q, `SELECT count(*) AS c FROM memberships WHERE role='owner'`);
        if (owners <= 1) throw conflict('A workspace must keep at least one owner');
      }
      await q.query(`UPDATE memberships SET role=$2 WHERE user_id=$1`, [targetId, newRole]);
      await audit(q, { tenantId, actorId: userId, action: 'member.role_changed', entity: 'user', entityId: targetId, meta: { from: target.role, to: newRole } });
      return { userId: targetId, role: newRole };
    }),
  );

  app.delete(
    '/t/members/:userId',
    tenantRoute(app, 'member:read', async ({ q, req, reply, role: actor, tenantId, userId }) => {
      const { userId: targetId } = parse(userIdParam, req.params);
      const leaving = targetId === userId;
      const target = (await q.query<{ role: Role }>(`SELECT role FROM memberships WHERE user_id=$1 FOR UPDATE`, [targetId]))[0];
      if (!target) throw notFound('Member not found');
      // Cualquiera puede abandonar el workspace; expulsar a otros requiere member:manage y jerarquía.
      if (!leaving && !canAssignRole(actor, target.role, null)) throw forbidden('You cannot remove this member');
      if (target.role === 'owner') {
        const owners = await countOf(q, `SELECT count(*) AS c FROM memberships WHERE role='owner'`);
        if (owners <= 1) throw conflict('A workspace must keep at least one owner');
      }
      await q.query(`DELETE FROM memberships WHERE user_id=$1`, [targetId]);
      await audit(q, { tenantId, actorId: userId, action: leaving ? 'member.left' : 'member.removed', entity: 'user', entityId: targetId });
      reply.status(204);
      return null;
    }),
  );

  app.post(
    '/t/invitations',
    tenantRoute(app, 'member:invite', async ({ q, req, reply, tenant, tenantId, userId, role: actor }) => {
      const body = parse(inviteSchema, req.body);
      if (body.role === 'admin' && actor !== 'owner' && actor !== 'admin') throw forbidden();
      await q.query(`SELECT id FROM tenants FOR UPDATE`);
      const usage = await usageOf(q);
      if (usage.members + usage.pendingInvitations >= limitsOf(tenant.plan).members) {
        throw paymentRequired(`Your ${tenant.plan} plan seat limit is reached. Upgrade to invite more people.`);
      }
      const already = await q.query(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE lower(u.email)=$1`, [body.email]);
      if (already.length) throw conflict('That user is already a member');

      const token = randomToken();
      const inv = (
        await q.query(
          `INSERT INTO invitations(tenant_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, role, expires_at`,
          [tenantId, body.email, body.role, hashToken(token), userId, new Date(Date.now() + INVITE_TTL_MS)],
        )
      )[0];
      await audit(q, { tenantId, actorId: userId, action: 'invitation.created', entity: 'invitation', entityId: inv.id, meta: { email: body.email, role: body.role } });
      reply.status(201);
      // En producción este token se enviaría por email; aquí se devuelve para poder probar el flujo.
      return { ...inv, token, acceptUrl: `${app.cfg.WEB_ORIGIN}/accept-invite?token=${token}` };
    }),
  );

  app.delete(
    '/t/invitations/:id',
    tenantRoute(app, 'member:invite', async ({ q, req, reply, tenantId, userId }) => {
      const { id } = parse(idParam, req.params);
      const del = await q.query(`DELETE FROM invitations WHERE id=$1 AND accepted_at IS NULL RETURNING email`, [id]);
      if (!del.length) throw notFound('Invitation not found');
      await audit(q, { tenantId, actorId: userId, action: 'invitation.revoked', entity: 'invitation', entityId: id });
      reply.status(204);
      return null;
    }),
  );

  // Aceptar invitación: el usuario aún no es miembro, así que se hace con el rol admin de DB.
  app.post('/invitations/accept', async (req) => {
    const userId = await requireAuth(req);
    const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
    return app.db.admin(async (q) => {
      const inv = (
        await q.query(
          `SELECT id, tenant_id, email, role, expires_at, accepted_at FROM invitations WHERE token_hash=$1 FOR UPDATE`,
          [hashToken(token)],
        )
      )[0];
      if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) throw badRequest('Invitation is invalid or expired');
      const user = (await q.query(`SELECT email FROM users WHERE id=$1`, [userId]))[0];
      if (!user) throw unauthorized();
      if (user.email.toLowerCase() !== inv.email.toLowerCase()) throw forbidden('This invitation was issued for a different email');

      await q.query(`INSERT INTO memberships(tenant_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [inv.tenant_id, userId, inv.role]);
      await q.query(`UPDATE invitations SET accepted_at=now() WHERE id=$1`, [inv.id]);
      await audit(q, { tenantId: inv.tenant_id, actorId: userId, action: 'invitation.accepted', entity: 'invitation', entityId: inv.id });
      const tenant = (await q.query(`SELECT id, name, slug, plan FROM tenants WHERE id=$1`, [inv.tenant_id]))[0];
      return { tenant: { ...tenant, role: inv.role } };
    });
  });
}
