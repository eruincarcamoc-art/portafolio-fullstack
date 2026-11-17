import { createHash, randomBytes } from 'node:crypto';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Los tokens opacos (refresh, invitaciones) se guardan solo como hash SHA-256. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function slugify(input: string): string {
  const base = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}
