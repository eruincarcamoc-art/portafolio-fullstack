import { Board, makePlace, type CardView, type ColumnView, type Op } from './board.js';
import { Clock } from './hlc.js';
import { between, FIRST_KEY } from './fractional.js';

export const newId = (rand: () => number = Math.random): string =>
  Array.from({ length: 12 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)]).join('');

/**
 * Capa de comandos sobre el CRDT: cada método aplica localmente y devuelve las operaciones
 * generadas, que el cliente de sincronización se encarga de enviar.
 */
export class BoardDoc {
  constructor(
    readonly board: Board,
    readonly clock: Clock,
    private readonly rand: () => number = Math.random,
    /** Se invoca con las operaciones locales ya aplicadas (el cliente las encola para enviarlas). */
    private readonly emit: (ops: Op[]) => void = () => {},
  ) {}

  private mk(ops: Omit<Op, 'ts'>[]): Op[] {
    const out = ops.map((o) => ({ ...o, ts: this.clock.tick() }));
    for (const op of out) this.board.apply(op);
    if (out.length) this.emit(out);
    return out;
  }

  view(): ColumnView[] {
    return this.board.view();
  }

  private column(id: string): ColumnView | undefined {
    return this.board.view().find((c) => c.id === id);
  }

  // ---- columnas ----
  createColumn(title: string): Op[] {
    const cols = this.view();
    const pos = between(cols.at(-1)?.pos ?? null, null);
    const id = newId(this.rand);
    return this.mk([
      { e: 'column', id, f: 'title', v: title },
      { e: 'column', id, f: 'pos', v: pos },
    ]);
  }
  renameColumn(id: string, title: string): Op[] {
    return this.mk([{ e: 'column', id, f: 'title', v: title }]);
  }
  moveColumn(id: string, index: number): Op[] {
    const others = this.view().filter((c) => c.id !== id);
    const i = clamp(index, 0, others.length);
    return this.mk([{ e: 'column', id, f: 'pos', v: between(others[i - 1]?.pos ?? null, others[i]?.pos ?? null) }]);
  }
  deleteColumn(id: string): Op[] {
    return this.mk([{ e: 'column', id, f: 'del', v: true }]);
  }

  // ---- tarjetas ----
  createCard(colId: string, title: string, desc = ''): Op[] {
    const col = this.column(colId);
    const pos = between(col?.cards.at(-1)?.pos ?? null, null);
    const id = newId(this.rand);
    return this.mk([
      { e: 'card', id, f: 'title', v: title },
      { e: 'card', id, f: 'desc', v: desc },
      { e: 'card', id, f: 'place', v: makePlace(colId, pos) },
    ]);
  }
  editCard(id: string, patch: { title?: string; desc?: string }): Op[] {
    const ops: Omit<Op, 'ts'>[] = [];
    if (patch.title !== undefined) ops.push({ e: 'card', id, f: 'title', v: patch.title });
    if (patch.desc !== undefined) ops.push({ e: 'card', id, f: 'desc', v: patch.desc });
    return this.mk(ops);
  }
  /** Mueve a `colId` en la posición `index` (0 = arriba). Una sola clave fraccionaria nueva. */
  moveCard(id: string, colId: string, index: number): Op[] {
    const target = (this.column(colId)?.cards ?? []).filter((c) => c.id !== id);
    const i = clamp(index, 0, target.length);
    const pos = between(target[i - 1]?.pos ?? null, target[i]?.pos ?? null);
    return this.mk([{ e: 'card', id, f: 'place', v: makePlace(colId, pos) }]);
  }
  deleteCard(id: string): Op[] {
    return this.mk([{ e: 'card', id, f: 'del', v: true }]);
  }

  /** Tablero inicial por defecto (solo se crea si el tablero está vacío). */
  seedDefaults(): Op[] {
    return ['To do', 'In progress', 'Done'].flatMap((t) => this.createColumn(t));
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export type { CardView, ColumnView };
export { FIRST_KEY };
