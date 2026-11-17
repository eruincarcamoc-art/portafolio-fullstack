import { describe, it, expect } from 'vitest';
import { parse, type ParsedCron } from '../src/index.js';

/**
 * ORÁCULO DE FUERZA BRUTA.
 * Recorre CADA minuto real del intervalo y decide con código propio (independiente de schedule.ts) si cada uno es una
 * ejecución. Después se compara con lo que devuelven between() / matches(). Así se verifican a la vez el algoritmo
 * de búsqueda "saltarín" de next() y las reglas de horario de verano.
 */

const MIN = 60_000;
const HOUR = 3_600_000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;

// ---- hora de pared, implementada aquí con su propio Intl (no reutiliza src/tz.ts)
const fmts = new Map<string, Intl.DateTimeFormat>();
function wallNaive(ms: number, tz: string): number {
  if (tz === 'UTC') return ms;
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })));
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return Date.UTC(o.year!, o.month! - 1, o.day!, o.hour!, o.minute!, o.second!);
}

function dayMatches(p: ParsedCron, d: Date): boolean {
  const dom = p.dom.values.includes(d.getUTCDate());
  const dow = p.dow.values.includes(d.getUTCDay());
  return p.dom.star || p.dow.star ? dom && dow : dom || dow;
}
function wallMatches(p: ParsedCron, wn: number): boolean {
  const d = new Date(wn);
  return p.months.values.includes(d.getUTCMonth() + 1) && p.hours.values.includes(d.getUTCHours()) && p.minutes.values.includes(d.getUTCMinutes()) && dayMatches(p, d);
}

/** Todos los minutos (start, end] en los que corre la expresión, según las reglas documentadas. */
function reference(p: ParsedCron, tz: string, start: number, end: number, gap: 'shift' | 'skip'): number[] {
  const out: number[] = [];
  const fixedHour = !p.hours.star;
  const seen = new Map<number, number>(); // hora de pared -> instante en que se vio por primera vez (para detectar la "segunda vez")
  let prev: number | null = null;
  const first = Math.floor(start / MIN) * MIN - 5 * HOUR;
  for (let t = first; t <= end; t += MIN) {
    const wn = wallNaive(t, tz);
    let run = false;
    const firstSeen = seen.get(wn);
    const repeated = firstSeen !== undefined && t - firstSeen <= 4 * HOUR && t !== firstSeen;
    if (wallMatches(p, wn)) run = !(fixedHour && repeated);
    if (!run && gap === 'shift' && prev !== null && wn - prev > MIN) {
      for (let w = prev + MIN; w < wn; w += MIN) if (wallMatches(p, w)) { run = true; break; }
    }
    if (tz !== 'UTC' && firstSeen === undefined) seen.set(wn, t);
    prev = wn;
    if (run && t > start) out.push(t);
  }
  return out;
}

// ---- generador de expresiones aleatorias
function randomExpression(r: () => number, dstBias: boolean): string {
  const minute = pick(r, ['*', '*/2', '*/5', '*/15', '*/20', '*/30', '0', '30', '15,45', '5,20,35', '10-20', '0-30/10', '59', '7']);
  const hour = dstBias
    ? pick(r, ['*', '*/2', '*/3', '1', '2', '3', '1,3', '2-4', '0-3', '1-2', '0', '2,14', '23', '4'])
    : pick(r, ['*', '*/2', '*/6', '0', '9', '9-17', '0,12', '3,15', '23', '8-10']);
  const dom = pick(r, ['*', '*', '*', '*', '1', '15', '1,15', '*/2', '29-31', '10-20', '28']);
  const month = pick(r, ['*', '*', '*', '*', '3', '11', '3,10', '1-6', '*/3']);
  const dow = pick(r, ['*', '*', '*', '*', '1-5', '0,6', '0', '3', '1,3,5', '*/2']);
  return `${minute} ${hour} ${dom} ${month} ${dow}`;
}

describe('oracle: UTC, random expressions vs minute-by-minute brute force', () => {
  it('between() returns exactly the runs found by brute force (150 expressions × 31 days)', () => {
    const r = rng(20260301);
    let totalRuns = 0;
    for (let i = 0; i < 150; i++) {
      const expr = randomExpression(r, false);
      const startDay = Date.UTC(2026 + Math.floor(r() * 3), Math.floor(r() * 12), 1 + Math.floor(r() * 28));
      const start = startDay + Math.floor(r() * 1440) * MIN;
      const end = start + 31 * 86_400_000;
      const s = parse(expr);
      const expected = reference(s.parsed, 'UTC', start, end, 'shift');
      const actual = s.between(start, end, { limit: 1_000_000 }).map(Number);
      expect(actual, `${expr} from ${new Date(start).toISOString()}`).toEqual(expected);
      totalRuns += expected.length;
    }
    expect(totalRuns).toBeGreaterThan(10_000); // el test ejercita volumen real, no casos vacíos
  });

  it('matches() agrees with the brute-force set on every minute of a 3-day window', () => {
    const r = rng(7);
    for (let i = 0; i < 60; i++) {
      const expr = randomExpression(r, false);
      const s = parse(expr);
      const start = Date.UTC(2026, 5, 1 + Math.floor(r() * 20));
      const end = start + 3 * 86_400_000;
      const runs = new Set(reference(s.parsed, 'UTC', start - MIN, end, 'shift'));
      for (let t = start; t < end; t += MIN) expect(s.matches(t), `${expr} @ ${new Date(t).toISOString()}`).toBe(runs.has(t));
    }
  });

  it('seconds-level schedules agree with a second-by-second reference', () => {
    const r = rng(99);
    for (let i = 0; i < 25; i++) {
      const sec = pick(r, ['*/7', '*/15', '5,35', '0', '30-40', '*/20']);
      const expr = `${sec} ${pick(r, ['*', '*/10', '5', '0,30'])} ${pick(r, ['*', '1-3', '2'])} * * *`;
      const s = parse(expr, { seconds: true });
      const start = Date.UTC(2026, 0, 1, 0, 0, 0);
      const end = start + 4 * HOUR;
      const expected: number[] = [];
      for (let t = start + 1000; t <= end; t += 1000) {
        const d = new Date(t);
        if (s.parsed.seconds.values.includes(d.getUTCSeconds()) && s.parsed.minutes.values.includes(d.getUTCMinutes()) && s.parsed.hours.values.includes(d.getUTCHours())) expected.push(t);
      }
      expect(s.between(start, end, { limit: 1_000_000 }).map(Number), expr).toEqual(expected);
    }
  });
});

/** Instantes en que cambia el desfase de una zona durante 2026 (búsqueda horaria + refinado a minuto). */
function transitionsOf(tz: string): number[] {
  const out: number[] = [];
  let prevOff = wallNaive(Date.UTC(2026, 0, 1), tz) - Date.UTC(2026, 0, 1);
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += HOUR) {
    const off = wallNaive(t, tz) - t;
    if (off !== prevOff) { out.push(t); prevOff = off; }
  }
  return out;
}

describe('oracle: around real DST transitions of several zones', () => {
  // Nueva York (saltos de 1 h), Londres, Sídney (hemisferio sur), Lord Howe (¡salto de 30 min!),
  // St. John's (offset -3:30) y Madrid.
  const ZONES = ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Australia/Lord_Howe', 'America/St_Johns', 'Europe/Madrid'];

  for (const tz of ZONES) {
    it(`${tz}: between() and matches() match brute force across every transition, for 'shift' and 'skip'`, () => {
      const trans = transitionsOf(tz);
      expect(trans.length).toBeGreaterThanOrEqual(2); // hay cambio de verano e invierno
      const r = rng(tz.length * 977);
      let checked = 0;
      for (const tr of trans) {
        const start = tr - 30 * HOUR;
        const end = tr + 30 * HOUR;
        for (let i = 0; i < 9; i++) {
          const expr = randomExpression(r, true);
          for (const gap of ['shift', 'skip'] as const) {
            const s = parse(expr, { tz, dstGap: gap });
            const expected = reference(s.parsed, tz, start, end, gap);
            const actual = s.between(start, end, { limit: 1_000_000 }).map(Number);
            expect(actual, `${tz} ${gap} "${expr}" around ${new Date(tr).toISOString()}`).toEqual(expected);
            checked += expected.length;

            // matches() por minuto en la ventana más delicada (±3 h del cambio)
            const set = new Set(expected);
            for (let t = tr - 3 * HOUR; t <= tr + 3 * HOUR; t += MIN) {
              expect(s.matches(t), `${tz} ${gap} "${expr}" matches @ ${new Date(t).toISOString()}`).toBe(set.has(t));
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(200);
    }, 120_000);
  }

  it('results are always strictly increasing and unique (never a duplicate across a repeated hour)', () => {
    for (const tz of ZONES) {
      for (const tr of transitionsOf(tz)) {
        for (const expr of ['*/20 * * * *', '0 * * * *', '30 1 * * *', '15,45 2 * * *', '0 0-4 * * *']) {
          const runs = parse(expr, { tz }).between(tr - 30 * HOUR, tr + 30 * HOUR, { limit: 100_000 }).map(Number);
          for (let i = 1; i < runs.length; i++) expect(runs[i]!).toBeGreaterThan(runs[i - 1]!);
        }
      }
    }
  }, 120_000);
});
