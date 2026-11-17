export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'project:read'
  | 'project:write'
  | 'project:delete'
  | 'member:read'
  | 'member:invite'
  | 'member:manage'
  | 'billing:read'
  | 'billing:manage'
  | 'audit:read';

const viewer: Permission[] = ['project:read', 'member:read'];
const member: Permission[] = [...viewer, 'project:write'];
const admin: Permission[] = [...member, 'project:delete', 'member:invite', 'member:manage', 'billing:read', 'audit:read'];
const owner: Permission[] = [...admin, 'billing:manage'];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(viewer),
  member: new Set(member),
  admin: new Set(admin),
  owner: new Set(owner),
};

export const can = (role: Role, permission: Permission): boolean => MATRIX[role].has(permission);

/**
 * Reglas de gestión de miembros:
 *  - Solo un owner puede tocar a otro owner o promover a alguien a owner.
 *  - Un admin puede gestionar admin/member/viewer.
 */
export function canAssignRole(actor: Role, target: Role, newRole: Role | null): boolean {
  if (actor !== 'owner' && (target === 'owner' || newRole === 'owner')) return false;
  return can(actor, 'member:manage');
}
