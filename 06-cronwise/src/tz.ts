/**
 * Zonas horarias sin dependencias, sobre `Intl.DateTimeFormat`.
 *
 * Un "Wall" es la hora de pared (lo que marca el reloj de la pared en esa zona): año, mes (1-12), día, hora,
 * minuto, segundo. Convertir Wall → instante NO es una función:
 *   - en el HUECO del cambio a horario de verano (02:30 el día que 02:00 salta a 03:00) hay 0 instantes,
 *   - en el SOLAPE del cambio a horario de invierno (01:30 ocurre dos veces) hay 2.
 * Todo el módulo existe para tratar esos dos casos explícitamente.
 */
export interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export class TimezoneError extends Error {
  constructor(readonly tz: string) {
    super(`Unknown time zone "${tz}"`);
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
    } catch {
      throw new TimezoneError(tz);
    }
    formatters.set(tz, f);
  }
  return f;
}

export function assertTimezone(tz: string): void {
  formatter(tz);
}

/** Milisegundos epoch de un Wall interpretado como si fuera UTC ("tiempo ingenuo"). */
export const naive = (w: Wall): number => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

export const fromNaive = (ms: number): Wall => {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
};

/** Hora de pared de un instante en la zona `tz`. */
export function toWall(instant: number, tz: string): Wall {
  if (tz === 'UTC') return fromNaive(instant);
  const parts = formatter(tz).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Desfase (ms) de la zona respecto a UTC en un instante: `wall = instante + offset`. */
export function offsetAt(instant: number, tz: string): number {
  if (tz === 'UTC') return 0;
  const floored = Math.floor(instant / 1000) * 1000; // Intl trabaja a precisión de segundo
  return naive(toWall(floored, tz)) - floored;
}

const DAY = 86_400_000;

/**
 * Todos los instantes cuya hora de pared en `tz` es exactamente `w` (ordenados).
 * [] = hueco (la hora no existe), [a] = normal, [a, b] = solape (ocurre dos veces).
 */
export function wallToInstants(w: Wall, tz: string): number[] {
  const t0 = naive(w);
  if (tz === 'UTC') return [t0];
  // Los desfases de un día antes y un día después cubren cualquier transición cercana.
  const offsets = new Set([offsetAt(t0 - DAY, tz), offsetAt(t0 + DAY, tz)]);
  const out: number[] = [];
  for (const o of offsets) {
    const candidate = t0 - o;
    if (naive(toWall(candidate, tz)) === t0 && !out.includes(candidate)) out.push(candidate);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Primer instante a partir del cual la hora de pared "existe" de nuevo tras un hueco que contiene `w`.
 * (p. ej. Nueva York, 2026-03-08 02:30 → 03:00 EDT.) Búsqueda binaria sobre el cambio de desfase.
 */
export function gapEnd(w: Wall, tz: string): number {
  const t0 = naive(w);
  const before = offsetAt(t0 - DAY, tz);
  const after = offsetAt(t0 + DAY, tz);
  let lo = t0 - before - 2 * DAY; // desfase = before
  let hi = t0 - after + 2 * DAY; // desfase = after
  // Invariante: offsetAt(lo) === before, offsetAt(hi) === after. Se busca el primer instante con `after`.
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2 / 1000) * 1000;
    if (offsetAt(mid, tz) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** ¿Observa la zona horario de verano? (compara el desfase en enero y julio del año dado). */
export function observesDst(tz: string, year = new Date().getUTCFullYear()): boolean {
  if (tz === 'UTC') return false;
  return offsetAt(Date.UTC(year, 0, 1), tz) !== offsetAt(Date.UTC(year, 6, 1), tz);
}
