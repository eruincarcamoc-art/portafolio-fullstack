import type { Config } from '../config.js';
import { createPgDb } from './pg.js';
import { createPgliteDb } from './pglite.js';
import type { Db } from './types.js';

export function createDb(cfg: Config): Db {
  return cfg.DATABASE_URL ? createPgDb(cfg.DATABASE_URL) : createPgliteDb(cfg.PGLITE_DIR);
}
export type { Db, Queryable } from './types.js';
