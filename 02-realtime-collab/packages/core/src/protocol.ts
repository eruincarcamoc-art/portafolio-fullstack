import { z } from 'zod';
import { isValidTs } from './hlc.js';
import { isValidKey } from './fractional.js';
import { parsePlace, type Op } from './board.js';

export const LIMITS = {
  maxOpsPerMessage: 500,
  maxStringLen: 5000,
  maxCards: 5000,
  maxColumns: 50,
} as const;

const idSchema = z.string().regex(/^[a-z0-9]{1,32}$/);
const tsSchema = z.string().refine(isValidTs, 'invalid timestamp');
const text = (max: number) => z.string().max(max);

const isValidPlace = (s: string): boolean => {
  const [col, pos] = parsePlace(s);
  return idSchema.safeParse(col).success && isValidKey(pos);
};

const opBase = { ts: tsSchema, id: idSchema };

/** Cada (entidad, campo) acepta solo el tipo de valor que le corresponde. */
const opSchema = z.discriminatedUnion('k', [
  z.object({ ...opBase, k: z.literal('card.title'), v: text(300) }),
  z.object({ ...opBase, k: z.literal('card.desc'), v: text(LIMITS.maxStringLen) }),
  z.object({ ...opBase, k: z.literal('card.place'), v: z.string().refine(isValidPlace, 'invalid place') }),
  z.object({ ...opBase, k: z.literal('card.del'), v: z.boolean() }),
  z.object({ ...opBase, k: z.literal('column.title'), v: text(100) }),
  z.object({ ...opBase, k: z.literal('column.pos'), v: z.string().refine(isValidKey, 'invalid position') }),
  z.object({ ...opBase, k: z.literal('column.del'), v: z.boolean() }),
]);

/** En el cable una op es {ts,e,id,f,v}; se valida contra la tabla (entidad.campo -> tipo de valor). */
export const wireOp = z
  .object({ ts: z.string(), e: z.enum(['card', 'column']), id: z.string(), f: z.string(), v: z.union([z.string(), z.number(), z.boolean(), z.null()]) })
  .transform((o, ctx): Op => {
    const r = opSchema.safeParse({ ts: o.ts, id: o.id, k: `${o.e}.${o.f}`, v: o.v });
    if (!r.success) {
      for (const i of r.error.issues) ctx.addIssue({ code: 'custom', message: i.message, path: i.path });
      return z.NEVER;
    }
    return { ts: o.ts, e: o.e, id: o.id, f: o.f, v: o.v };
  });

export const opsArray = z.array(wireOp).max(LIMITS.maxOpsPerMessage);

// ---------- cliente -> servidor ----------
export const clientMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    clientId: z.string().regex(/^[A-Za-z0-9_]{1,32}$/),
    name: z.string().trim().min(1).max(30),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    since: z.number().int().min(0),
    epoch: z.string().max(40).nullable(),
  }),
  z.object({ t: z.literal('ops'), batch: z.number().int().min(0), ops: opsArray }),
  z.object({ t: z.literal('presence'), focus: idSchema.nullable(), editing: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

// ---------- servidor -> cliente ----------
export interface Peer {
  id: string;
  name: string;
  color: string;
  focus: string | null;
  editing: boolean;
}

export type ServerMessage =
  | { t: 'sync'; epoch: string; seq: number; ops: Op[]; done: boolean }
  | { t: 'ops'; seq: number; ops: Op[] }
  | { t: 'ack'; batch: number; seq: number }
  | { t: 'presence'; peers: Peer[] }
  | { t: 'error'; code: string; message: string }
  | { t: 'hb' };
