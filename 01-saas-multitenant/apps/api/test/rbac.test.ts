import { describe, it, expect } from 'vitest';
import { can, canAssignRole, ROLES } from '../src/domain/rbac.js';
import { slugify } from '../src/domain/security.js';

describe('rbac', () => {
  it('roles are strictly cumulative', () => {
    expect(can('viewer', 'project:write')).toBe(false);
    expect(can('member', 'project:write')).toBe(true);
    expect(can('member', 'project:delete')).toBe(false);
    expect(can('admin', 'billing:manage')).toBe(false);
    expect(can('owner', 'billing:manage')).toBe(true);
  });
  it('every role can read projects', () => {
    for (const r of ROLES) expect(can(r, 'project:read')).toBe(true);
  });
  it('only owners can touch owners', () => {
    expect(canAssignRole('admin', 'owner', 'member')).toBe(false);
    expect(canAssignRole('admin', 'member', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'member', 'viewer')).toBe(true);
    expect(canAssignRole('owner', 'owner', 'admin')).toBe(true);
    expect(canAssignRole('member', 'viewer', 'member')).toBe(false);
  });
});

describe('slugify', () => {
  it('normalises accents and symbols', () => {
    expect(slugify('Café  & Té!')).toBe('cafe-te');
    expect(slugify('!!!')).toBe('workspace');
  });
});
