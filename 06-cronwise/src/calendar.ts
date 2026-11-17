/** Utilidades de calendario puras (sin zonas horarias): todo opera sobre "hora de pared" en UTC. */

export const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Meses 1-12. */
export const daysInMonth = (y: number, m: number): number => (m === 2 && isLeap(y) ? 29 : DAYS[m - 1]!);

/** Día de la semana 0 (domingo) - 6 (sábado) de una fecha civil. */
export const weekday = (y: number, m: number, d: number): number => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** n-ésimo (1-5) día de la semana `dow` del mes: devuelve el día del mes, o null si no existe (p. ej. 5.º lunes). */
export function nthWeekday(y: number, m: number, dow: number, n: number): number | null {
  const first = weekday(y, m, 1);
  const day = 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  return day <= daysInMonth(y, m) ? day : null;
}

/** Último día de la semana `dow` del mes. */
export function lastWeekday(y: number, m: number, dow: number): number {
  const last = daysInMonth(y, m);
  return last - ((weekday(y, m, last) - dow + 7) % 7);
}

/**
 * Día laborable (lun-vie) más cercano a `day` SIN salirse del mes (semántica de Quartz para `W`):
 * el sábado pasa al viernes (o al lunes si el viernes cae en el mes anterior), el domingo pasa al lunes
 * (o al viernes si el lunes cae en el mes siguiente).
 */
export function nearestWeekday(y: number, m: number, day: number): number | null {
  const last = daysInMonth(y, m);
  if (day > last) return null;
  const w = weekday(y, m, day);
  if (w >= 1 && w <= 5) return day;
  if (w === 6) return day > 1 ? day - 1 : day + 2;
  return day < last ? day + 1 : day - 2;
}

/** Último día laborable del mes (`LW`). */
export function lastWeekdayOfMonth(y: number, m: number): number {
  const last = daysInMonth(y, m);
  const w = weekday(y, m, last);
  return w === 6 ? last - 1 : w === 0 ? last - 2 : last;
}

/** Suma `n` días a una fecha civil. */
export function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
