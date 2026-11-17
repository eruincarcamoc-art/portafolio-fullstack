/**
 * Índices fraccionarios: strings ordenables lexicográficamente con los que siempre se puede
 * insertar entre dos elementos sin renumerar los demás (un reorder = 1 op, no N).
 *
 * Base 62. Invariante: ninguna clave termina en '0' (así siempre existe una clave
 * intermedia). Algoritmo de punto medio de D. Greenspan.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const idx = (c: string | undefined): number => (c === undefined ? 0 : DIGITS.indexOf(c));

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`midpoint: ${a} >= ${b}`);
  if (b !== null) {
    // Prefijo común: se conserva y se resuelve el resto.
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = idx(a[0]);
  const db = b !== null ? idx(b[0]) : BASE;
  // Extremos (añadir al final / al principio): avanzar de 1 en 1 en vez de bisecar.
  // Así una clave absorbe ~60 inserciones antes de crecer, en lugar de ~6.
  if (b === null && a !== '' && da < BASE - 1) return DIGITS[da + 1]!;
  if (a === '' && b !== null && db > 1) return DIGITS[db - 1]!;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))]!;
  // Dígitos consecutivos: hay que bajar un nivel.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

export const FIRST_KEY = 'V';

/** Devuelve una clave estrictamente entre `a` y `b` (null = extremo abierto). */
export function between(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    // Posiciones iguales o invertidas (p. ej. dos clientes insertaron en el mismo hueco): colocar tras `a`.
    return midpoint(a, null);
  }
  const key = midpoint(a ?? '', b);
  return key;
}

export const isValidKey = (k: string): boolean => /^[0-9A-Za-z]{1,64}$/.test(k) && !k.endsWith('0');
