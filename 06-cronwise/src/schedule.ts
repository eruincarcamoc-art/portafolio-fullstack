import { daysInMonth, lastWeekday, lastWeekdayOfMonth, nearestWeekday, nthWeekday, weekday } from './calendar.js';
import { parseExpression } from './parse.js';
import { assertTimezone, fromNaive, gapEnd, naive, offsetAt, toWall, wallToInstants, type Wall } from './tz.js';
import type { ParseOptions, ParsedCron } from './types.js';
import { explainCron, type ExplainOptions } from './explain.js';

const HOUR = 3_600_000;
const MAX_YEARS = 9; // 29 de febrero puede tardar hasta 8 años (2096 → 2104, porque 2100 no es bisiesto)

const nextInSet = (values: number[], from: number): number | undefined => values.find((v) => v >= from);

export interface IterateOptions {
  /** Máximo de resultados (protección frente a rangos enormes). */
  limit?: number;
}

/**
 * Una programación cron lista para consultar. Inmutable.
 *
 * Semántica (documentada en el README y cubierta por tests):
 *  - Día del mes y día de la semana: si AMBOS están restringidos se combinan con OR (cron clásico); si uno es `*`, con AND.
 *  - Cambio a horario de verano, HUECO (hora inexistente): `dstGap: 'shift'` ejecuta en el primer instante válido; `'skip'` omite.
 *  - Cambio a horario de invierno, SOLAPE (hora repetida): una hora fija (`30 1 * * *`) se ejecuta UNA vez (la primera);
 *    una hora comodín (`0,30 * * * *`, `0 * * * *`) se ejecuta en cada instante real.
 */
export class Schedule {
  readonly tz: string;
  readonly parsed: ParsedCron;
  private readonly dstGap: 'shift' | 'skip';
  private readonly fixedHour: boolean;

  constructor(parsed: ParsedCron, opts: ParseOptions = {}) {
    this.tz = opts.tz ?? 'UTC';
    assertTimezone(this.tz);
    this.parsed = parsed;
    this.dstGap = opts.dstGap ?? 'shift';
    this.fixedHour = !parsed.hours.star;
  }

  /** Expresión normalizada (macros expandidas). */
  get expression(): string {
    return this.parsed.expression;
  }

  toString(): string {
    return this.parsed.expression;
  }

  explain(opts?: ExplainOptions): string {
    return explainCron(this.parsed, opts);
  }

  // ------------------------------------------------------------------ coincidencia por hora de pared
  private dayMatches(y: number, mo: number, d: number): boolean {
    const { dom, dow } = this.parsed;
    const dim = daysInMonth(y, mo);
    const domMatch =
      dom.values.includes(d) ||
      (dom.last && d === dim) ||
      (dom.lastWeekday && d === lastWeekdayOfMonth(y, mo)) ||
      dom.nearest.some((n) => nearestWeekday(y, mo, n) === d);
    const w = weekday(y, mo, d);
    const dowMatch =
      dow.values.includes(w) ||
      dow.nth.some((x) => x.dow === w && nthWeekday(y, mo, x.dow, x.n) === d) ||
      dow.last.some((x) => x === w && lastWeekday(y, mo, x) === d);
    // Regla clásica (Vixie): con ambos restringidos, OR; si alguno es "*", AND.
    return dom.star || dow.star ? domMatch && dowMatch : domMatch || dowMatch;
  }

  private wallMatches(w: Wall): boolean {
    const p = this.parsed;
    return (
      p.months.values.includes(w.mo) &&
      p.hours.values.includes(w.h) &&
      p.minutes.values.includes(w.mi) &&
      p.seconds.values.includes(w.s) &&
      this.dayMatches(w.y, w.mo, w.d)
    );
  }

  /** Siguiente hora de pared coincidente, estrictamente posterior a `after` (resolución de minuto, o de segundo con `seconds`). */
  private nextWall(after: Wall): Wall | null {
    const p = this.parsed;
    const unitMs = p.hasSeconds ? 1000 : 60_000;
    let t = fromNaive(Math.floor(naive(after) / unitMs) * unitMs + unitMs);
    let { y, mo, d, h, mi, s } = t;
    const limitYear = after.y + MAX_YEARS;

    for (;;) {
      if (y > limitYear) return null;

      const m2 = nextInSet(p.months.values, mo);
      if (m2 === undefined) { y++; mo = 1; d = 1; h = mi = s = 0; continue; }
      if (m2 !== mo) { mo = m2; d = 1; h = mi = s = 0; }

      if (d > daysInMonth(y, mo) || !this.dayMatches(y, mo, d)) {
        d++;
        h = mi = s = 0;
        if (d > daysInMonth(y, mo)) { d = 1; mo++; if (mo > 12) { mo = 1; y++; } }
        continue;
      }

      const h2 = nextInSet(p.hours.values, h);
      if (h2 === undefined) { d++; h = mi = s = 0; if (d > daysInMonth(y, mo)) { d = 1; mo++; if (mo > 12) { mo = 1; y++; } } continue; }
      if (h2 !== h) { h = h2; mi = s = 0; }

      const mi2 = nextInSet(p.minutes.values, mi);
      if (mi2 === undefined) { h++; mi = s = 0; if (h > 23) { h = 0; d++; if (d > daysInMonth(y, mo)) { d = 1; mo++; if (mo > 12) { mo = 1; y++; } } } continue; }
      if (mi2 !== mi) { mi = mi2; s = 0; }

      const s2 = nextInSet(p.seconds.values, s);
      if (s2 === undefined) { mi++; s = 0; if (mi > 59) { mi = 0; h++; if (h > 23) { h = 0; d++; if (d > daysInMonth(y, mo)) { d = 1; mo++; if (mo > 12) { mo = 1; y++; } } } } continue; }
      s = s2;
      return { y, mo, d, h, mi, s };
    }
  }

  /** Instantes reales (epoch ms) en los que se ejecuta la hora de pared `w`, aplicando las reglas de DST. */
  private instantsOf(w: Wall): number[] {
    if (this.tz === 'UTC') return [naive(w)];
    const inst = wallToInstants(w, this.tz);
    if (inst.length === 0) return this.dstGap === 'shift' ? [gapEnd(w, this.tz)] : [];
    if (inst.length === 2 && this.fixedHour) return [inst[0]!]; // hora fija en un solape: solo la primera vez
    return inst;
  }

  // ------------------------------------------------------------------ API pública
  /** Primera ejecución estrictamente posterior a `from`, o `null` si no hay ninguna en los próximos ~9 años. */
  next(from: Date | number = Date.now()): Date | null {
    const fromMs = Math.floor(+from / 1000) * 1000;
    if (!Number.isFinite(fromMs)) throw new TypeError('`from` must be a valid Date');

    // Cerca de un cambio de hora el orden de las horas de pared y el de los instantes no coincide: hay que
    // mirar hacia atrás (la hora repetida) y escanear un poco más allá. Lejos de cualquier cambio basta el camino rápido.
    const nearTransition = this.tz !== 'UTC' && offsetAt(fromMs - 3 * HOUR, this.tz) !== offsetAt(fromMs + 3 * HOUR, this.tz);
    let cursor = toWall(fromMs, this.tz);
    if (nearTransition) cursor = fromNaive(naive(cursor) - 3 * HOUR);

    let best: number | null = null;
    for (let guard = 0; guard < 20_000; guard++) {
      const w = this.nextWall(cursor);
      if (!w) break;
      cursor = w;
      if (best !== null && naive(w) > naive(toWall(best, this.tz)) + 3 * HOUR) break;
      for (const i of this.instantsOf(w)) if (i > fromMs && (best === null || i < best)) best = i;
      if (best !== null && !nearTransition) break;
    }
    return best === null ? null : new Date(best);
  }

  /**
   * ¿Cae este instante dentro de una ejecución programada? Se compara a la resolución de la programación:
   * sin `seconds`, cualquier segundo de un minuto programado coincide (09:30:42 coincide con `30 9 * * *`).
   */
  matches(date: Date | number): boolean {
    const unit = this.parsed.hasSeconds ? 1000 : 60_000;
    const ms = Math.floor(+date / unit) * unit;
    const w = toWall(ms, this.tz);
    if (this.wallMatches(w)) {
      if (this.tz !== 'UTC' && this.fixedHour) {
        const inst = wallToInstants(w, this.tz);
        if (inst.length === 2 && ms !== inst[0]) return false; // segunda vez de una hora repetida
      }
      return true;
    }
    if (this.tz !== 'UTC' && this.dstGap === 'shift') {
      // ¿Es éste el primer instante tras un hueco? Entonces se ejecutan aquí las horas que quedaron saltadas.
      const before = offsetAt(ms - 1000, this.tz);
      const now = offsetAt(ms, this.tz);
      if (now > before) {
        // `ms` ES el primer instante tras el hueco. Se ejecuta aquí si alguna hora de pared saltada coincide.
        const unit = this.parsed.hasSeconds ? 1000 : 60_000;
        const firstSkipped = naive(toWall(ms - 1000, this.tz)) + 1000;
        for (let t = Math.ceil(firstSkipped / unit) * unit; t < naive(w); t += unit) {
          if (this.wallMatches(fromNaive(t))) return true;
        }
      }
    }
    return false;
  }

  /** Las próximas `count` ejecuciones a partir de `from` (por defecto, ahora). */
  nextRuns(count: number, from: Date | number = Date.now()): Date[] {
    const out: Date[] = [];
    for (const d of this.iterate(from)) {
      out.push(d);
      if (out.length >= count) break;
    }
    return out;
  }

  /** Ejecuciones en el intervalo (from, to]. */
  between(from: Date | number, to: Date | number, opts: IterateOptions = {}): Date[] {
    const limit = opts.limit ?? 10_000;
    const out: Date[] = [];
    for (const d of this.iterate(from)) {
      if (+d > +to || out.length >= limit) break;
      out.push(d);
    }
    return out;
  }

  /** Iterador perezoso de ejecuciones posteriores a `from`. */
  *iterate(from: Date | number = Date.now()): Generator<Date, void, undefined> {
    let cursor: number = +from;
    for (;;) {
      const n = this.next(cursor);
      if (!n) return;
      yield n;
      cursor = +n;
    }
  }
}

export function parse(expression: string, opts: ParseOptions = {}): Schedule {
  return new Schedule(parseExpression(expression, { seconds: opts.seconds ?? false }), opts);
}
