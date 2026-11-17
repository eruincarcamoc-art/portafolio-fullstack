import { createRequire } from 'node:module';

/**
 * `node:sqlite` se carga con createRequire: los bundlers/vitest recortan el prefijo `node:` de los módulos
 * integrados y `sqlite` solo existe CON prefijo.
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export type Database = InstanceType<typeof DatabaseSync>;
export const openDatabase = (path: string): Database => new DatabaseSync(path);
