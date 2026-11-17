import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { addMember, authHeaders, call, makeApp, register, type TestCtx } from './helpers.js';

let t: TestCtx;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(() => t.close());

describe('auth', () => {
  it('registers, logs in, and rejects bad credentials / duplicate emails', async () => {
    const s = await register(t.app, 'Ana');
    const dup = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: s.email, password: 'correct-horse-battery', name: 'X', workspaceName: 'X' },
    });
    expect(dup.statusCode).toBe(409);

    const ok = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.email, password: 'correct-horse-battery' } });
    expect(ok.statusCode).toBe(200);
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.email, password: 'nope-nope-nope' } });
    expect(bad.statusCode).toBe(401);
    const ghost = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@example.com', password: 'whatever123' } });
    expect(ghost.statusCode).toBe(401);
  });

  it('validates input with a structured 400', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'not-an-email', password: '1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('rotates refresh tokens and revokes the whole family on reuse', async () => {
    const s = await register(t.app, 'Rita');
    const r1 = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: s.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const fresh = r1.json().refreshToken;

    // Reusar el token ya rotado = posible robo: se invalidan todos.
    const replay = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: s.refreshToken } });
    expect(replay.statusCode).toBe(401);
    const afterReplay = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: fresh } });
    expect(afterReplay.statusCode).toBe(401);
  });

  it('protects routes', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer junk' } })).statusCode).toBe(401);
  });
});

describe('tenant isolation (end-to-end)', () => {
  it('a user cannot read or write another workspace, even guessing ids', async () => {
    const a = await register(t.app, 'Alice');
    const b = await register(t.app, 'Bob');

    const created = await call(t.app, a, a.tenantId)('POST', '/t/projects', { name: 'Secret' });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id;

    // Bob con el tenant de Alice -> 403 (no es miembro)
    expect((await call(t.app, b, a.tenantId)('GET', '/t/projects')).statusCode).toBe(403);
    expect((await call(t.app, b, a.tenantId)('POST', '/t/projects', { name: 'x' })).statusCode).toBe(403);

    // Bob en SU tenant intentando leer el id de Alice -> 404 (RLS lo oculta)
    expect((await call(t.app, b, b.tenantId)('GET', `/t/projects/${projectId}`)).statusCode).toBe(404);
    expect((await call(t.app, b, b.tenantId)('DELETE', `/t/projects/${projectId}`)).statusCode).toBe(404);

    // Sigue intacto
    expect((await call(t.app, a, a.tenantId)('GET', `/t/projects/${projectId}`)).statusCode).toBe(200);
  });

  it('requires a valid X-Tenant-Id', async () => {
    const a = await register(t.app, 'Carl');
    const res = await t.app.inject({ method: 'GET', url: '/api/t/projects', headers: authHeaders(a) });
    expect(res.statusCode).toBe(400);
  });
});

describe('RBAC + members', () => {
  it('enforces the permission matrix', async () => {
    const owner = await register(t.app, 'Olga');
    const viewer = await register(t.app, 'Vic');
    const member = await register(t.app, 'Mia');
    await addMember(t.app, owner, viewer, 'viewer');
    await addMember(t.app, owner, member, 'member');

    expect((await call(t.app, viewer, owner.tenantId)('GET', '/t/projects')).statusCode).toBe(200);
    expect((await call(t.app, viewer, owner.tenantId)('POST', '/t/projects', { name: 'no' })).statusCode).toBe(403);
    expect((await call(t.app, member, owner.tenantId)('POST', '/t/projects', { name: 'yes' })).statusCode).toBe(201);
    expect((await call(t.app, member, owner.tenantId)('POST', '/t/invitations', { email: 'a@b.co', role: 'viewer' })).statusCode).toBe(403);
    expect((await call(t.app, member, owner.tenantId)('GET', '/t/audit')).statusCode).toBe(403);
    expect((await call(t.app, member, owner.tenantId)('GET', '/t/billing')).statusCode).toBe(403);
  });

  it('protects owners: admins cannot demote them and the last owner cannot leave', async () => {
    const owner = await register(t.app, 'Oscar');
    const admin = await register(t.app, 'Adam');
    await addMember(t.app, owner, admin, 'admin');

    const demote = await call(t.app, admin, owner.tenantId)('PATCH', `/t/members/${owner.userId}`, { role: 'member' });
    expect(demote.statusCode).toBe(403);
    const promote = await call(t.app, admin, owner.tenantId)('PATCH', `/t/members/${admin.userId}`, { role: 'owner' });
    expect(promote.statusCode).toBe(403);

    const leave = await call(t.app, owner, owner.tenantId)('DELETE', `/t/members/${owner.userId}`);
    expect(leave.statusCode).toBe(409);
  });

  it('invitation can only be accepted by the invited email, once', async () => {
    const owner = await register(t.app, 'Ines');
    const invited = await register(t.app, 'Joe');
    const other = await register(t.app, 'Eve');
    const inv = await call(t.app, owner, owner.tenantId)('POST', '/t/invitations', { email: invited.email, role: 'member' });
    const token = inv.json().token;

    const wrong = await t.app.inject({ method: 'POST', url: '/api/invitations/accept', headers: authHeaders(other), payload: { token } });
    expect(wrong.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/invitations/accept', headers: authHeaders(invited), payload: { token } });
    expect(ok.statusCode).toBe(200);
    const again = await t.app.inject({ method: 'POST', url: '/api/invitations/accept', headers: authHeaders(invited), payload: { token } });
    expect(again.statusCode).toBe(400);

    const members = (await call(t.app, owner, owner.tenantId)('GET', '/t/members')).json();
    expect(members.members.map((m: any) => m.email)).toContain(invited.email);
  });
});

describe('plans, limits and billing (fake provider)', () => {
  it('enforces the free plan limit, then lifts it after an upgrade event', async () => {
    const o = await register(t.app, 'Pia');
    const api = call(t.app, o, o.tenantId);
    for (let i = 0; i < 3; i++) expect((await api('POST', '/t/projects', { name: `p${i}` })).statusCode).toBe(201);

    const blocked = await api('POST', '/t/projects', { name: 'p4' });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe('plan_limit');

    const up = await api('POST', '/t/billing/simulate', { action: 'pro' });
    expect(up.statusCode).toBe(200);
    expect((await api('GET', '/t')).json().tenant.plan).toBe('pro');
    expect((await api('POST', '/t/projects', { name: 'p4' })).statusCode).toBe(201);

    await api('POST', '/t/billing/simulate', { action: 'payment_failed' });
    expect((await api('GET', '/t/billing')).json().status).toBe('past_due');

    await api('POST', '/t/billing/simulate', { action: 'cancel' });
    expect((await api('GET', '/t')).json().tenant.plan).toBe('free');
  });

  it('never allows concurrent creates to exceed the limit', async () => {
    const o = await register(t.app, 'Race');
    const api = call(t.app, o, o.tenantId);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => api('POST', '/t/projects', { name: `r${i}` })));
    const created = results.filter((r) => r.statusCode === 201).length;
    expect(created).toBe(3);
  });

  it('only the owner can manage billing', async () => {
    const o = await register(t.app, 'Bea');
    const a = await register(t.app, 'Ade');
    await addMember(t.app, o, a, 'admin');
    expect((await call(t.app, a, o.tenantId)('GET', '/t/billing')).statusCode).toBe(200);
    expect((await call(t.app, a, o.tenantId)('POST', '/t/billing/checkout', { plan: 'pro' })).statusCode).toBe(403);
    const ok = await call(t.app, o, o.tenantId)('POST', '/t/billing/checkout', { plan: 'pro' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().url).toContain('fake_checkout=pro');
  });

  it('records every change in the audit log', async () => {
    const o = await register(t.app, 'Aud');
    const api = call(t.app, o, o.tenantId);
    await api('POST', '/t/projects', { name: 'logged' });
    const log = (await api('GET', '/t/audit')).json();
    expect(log.items.map((i: any) => i.action)).toEqual(expect.arrayContaining(['tenant.created', 'project.created']));
  });
});
