import type { Timestamp } from './hlc.js';

/**
 * CRDT del tablero: un mapa de entidades (tarjetas y columnas) cuyos campos son
 * registros LWW (last-writer-wins) con timestamp HLC.
 *
 * Propiedades (verificadas con tests de convergencia):
 *  - Conmutativa: el orden de llegada de las operaciones no importa.
 *  - Idempotente: aplicar dos veces la misma operación no cambia nada.
 *  - Asociativa: se pueden fusionar en lotes.
 * => convergencia eventual sin coordinación, también tras desconexiones largas.
 */
export type Value = string | number | boolean | null;
export type EntityKind = 'card' | 'column';

export interface Op {
  /** Timestamp HLC único (incluye el id del nodo): identifica y ordena la operación. */
  ts: Timestamp;
  e: EntityKind;
  id: string;
  f: string;
  v: Value;
}

interface Register {
  v: Value;
  ts: Timestamp;
}
type Fields = Map<string, Register>;

export interface CardView {
  id: string;
  title: string;
  desc: string;
  col: string;
  pos: string;
}
export interface ColumnView {
  id: string;
  title: string;
  pos: string;
  cards: CardView[];
}

const str = (r: Register | undefined, fallback = ''): string => (typeof r?.v === 'string' ? r.v : fallback);

export class Board {
  private cards = new Map<string, Fields>();
  private columns = new Map<string, Fields>();
  /** Se incrementa en cada cambio efectivo: útil para memoización / suscripciones. */
  version = 0;

  private table(kind: EntityKind): Map<string, Fields> {
    return kind === 'card' ? this.cards : this.columns;
  }

  /** ¿Cambiaría esta operación el estado? (sin aplicarla) */
  wouldChange(op: Op): boolean {
    const cur = this.table(op.e).get(op.id)?.get(op.f);
    return !cur || op.ts > cur.ts;
  }

  /** Aplica una operación. Devuelve true si cambió el estado (false si era redundante o perdía contra otra). */
  apply(op: Op): boolean {
    const table = this.table(op.e);
    let fields = table.get(op.id);
    if (!fields) {
      fields = new Map();
      table.set(op.id, fields);
    }
    const cur = fields.get(op.f);
    if (cur && op.ts <= cur.ts) return false;
    fields.set(op.f, { v: op.v, ts: op.ts });
    this.version++;
    return true;
  }

  applyAll(ops: readonly Op[]): Op[] {
    return ops.filter((o) => this.apply(o));
  }

  has(kind: EntityKind, id: string): boolean {
    return this.table(kind).has(id);
  }
  get cardCount(): number {
    return this.cards.size;
  }
  get columnCount(): number {
    return this.columns.size;
  }

  /** Vista derivada: columnas ordenadas, con sus tarjetas ordenadas. Los borrados no aparecen. */
  view(): ColumnView[] {
    const cols: ColumnView[] = [];
    for (const [id, f] of this.columns) {
      if (f.get('del')?.v === true || !f.has('title')) continue;
      cols.push({ id, title: str(f.get('title')), pos: str(f.get('pos'), 'V'), cards: [] });
    }
    cols.sort(byPosThenId);
    const byId = new Map(cols.map((c) => [c.id, c]));
    for (const [id, f] of this.cards) {
      if (f.get('del')?.v === true || !f.has('title')) continue;
      const [colId, pos] = parsePlace(str(f.get('place')));
      const col = byId.get(colId);
      if (!col) continue; // columna borrada o aún desconocida: la tarjeta queda oculta, no se pierde
      col.cards.push({ id, title: str(f.get('title')), desc: str(f.get('desc')), col: col.id, pos });
    }
    for (const c of cols) c.cards.sort(byPosThenId);
    return cols;
  }

  /** Estado mínimo equivalente: una op por registro vigente. Sirve de snapshot y de compactación. */
  snapshotOps(): Op[] {
    const out: Op[] = [];
    for (const [kind, table] of [['card', this.cards], ['column', this.columns]] as const) {
      for (const [id, fields] of table) {
        for (const [f, r] of fields) out.push({ ts: r.ts, e: kind, id, f, v: r.v });
      }
    }
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  /** Representación canónica para comparar réplicas en tests. */
  fingerprint(): string {
    return JSON.stringify(this.snapshotOps().sort((a, b) => (a.e + a.id + a.f < b.e + b.id + b.f ? -1 : 1)));
  }
}

/** Columna y posición viajan en UN registro: un movimiento nunca se mezcla con otro concurrente. */
export const makePlace = (col: string, pos: string): string => `${col}:${pos}`;
export function parsePlace(place: string): [string, string] {
  const i = place.indexOf(':');
  return i < 0 ? ['', 'V'] : [place.slice(0, i), place.slice(i + 1)];
}

function byPosThenId<T extends { pos: string; id: string }>(a: T, b: T): number {
  return a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
