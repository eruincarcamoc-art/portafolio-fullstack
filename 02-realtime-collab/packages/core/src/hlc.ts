/**
 * Hybrid Logical Clock (HLC).
 *
 * Cada operación lleva un timestamp `wall-counter-node` que:
 *  - respeta causalidad (si B ve a A, B > A) aunque los relojes físicos estén desfasados,
 *  - es un orden TOTAL (el `node` desempata), requisito para que LWW converja,
 *  - se compara como string (base36 con relleno fijo => orden lexicográfico = cronológico).
 */
export type Timestamp = string;

/** Un reloj remoto adelantado más de esto se ignora: evita que un cliente malicioso "envenene" el reloj. */
export const MAX_DRIFT_MS = 60 * 60 * 1000;

const TS_RE = /^([0-9a-z]{9})-([0-9a-z]{4})-([A-Za-z0-9_]{1,32})$/;

export interface ParsedTs {
  wall: number;
  counter: number;
  node: string;
}

export function encodeTs(wall: number, counter: number, node: string): Timestamp {
  return `${wall.toString(36).padStart(9, '0')}-${counter.toString(36).padStart(4, '0')}-${node}`;
}

export function parseTs(ts: string): ParsedTs | null {
  const m = TS_RE.exec(ts);
  if (!m) return null;
  return { wall: parseInt(m[1]!, 36), counter: parseInt(m[2]!, 36), node: m[3]! };
}

export const isValidTs = (ts: string): boolean => TS_RE.test(ts);

export class Clock {
  private wall = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    private readonly physical: () => number = Date.now,
  ) {
    if (!/^[A-Za-z0-9_]{1,32}$/.test(node)) throw new Error('Invalid node id');
  }

  /** Timestamp para un evento local. Estrictamente creciente. */
  tick(): Timestamp {
    const now = this.physical();
    if (now > this.wall) {
      this.wall = now;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return encodeTs(this.wall, this.counter, this.node);
  }

  /** Incorpora un timestamp remoto para que los siguientes `tick()` sean posteriores. */
  receive(ts: Timestamp): void {
    const r = parseTs(ts);
    if (!r || r.wall - this.physical() > MAX_DRIFT_MS) return;
    if (r.wall > this.wall || (r.wall === this.wall && r.counter > this.counter)) {
      this.wall = r.wall;
      this.counter = r.counter;
    }
  }
}
