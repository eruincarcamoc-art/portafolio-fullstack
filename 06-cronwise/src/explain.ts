import type { FieldSpec, ParsedCron } from './types.js';

export type Locale = 'en' | 'es';

export interface ExplainOptions {
  /** Idioma de la explicación. Por defecto 'en'. */
  locale?: Locale;
  /** Horas en formato 12 h (9:30 AM). Por defecto 24 h (09:30). */
  hour12?: boolean;
}

// ------------------------------------------------------------------ utilidades sobre conjuntos de valores
const full = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const isAll = (s: FieldSpec, min: number, max: number) => s.values.length === max - min + 1;

/** Si los valores son min, min+n, min+2n... hasta el máximo posible (n > 1), devuelve n. */
function stepOf(values: number[], min: number, max: number): number | null {
  if (values.length < 2 || values[0] !== min) return null;
  const n = values[1]! - values[0]!;
  if (n < 2) return null;
  for (let i = 0; i < values.length; i++) if (values[i] !== min + i * n) return null;
  return values.at(-1)! + n > max ? n : null;
}

const isRange = (values: number[]) => values.length >= 2 && values.every((v, i) => i === 0 || v === values[i - 1]! + 1);

/** Agrupa en tramos consecutivos: [1,2,3,5] → [[1,3],[5,5]]. */
function runs(values: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const v of values) {
    const last = out.at(-1);
    if (last && v === last[1] + 1) last[1] = v;
    else out.push([v, v]);
  }
  return out;
}

// ------------------------------------------------------------------ idiomas
interface Words {
  join(items: string[]): string;
  through(a: string, b: string): string;
  months: string[];
  weekdays: string[]; // domingo primero
  ordinal: string[]; // 1.º..5.º
  every(n: number, unit: 'second' | 'minute' | 'hour' | 'day' | 'month'): string;
  everyOne: Record<'second' | 'minute' | 'hour' | 'day' | 'month', string>;
  atTimes(times: string[]): string;
  atMinutes(mins: number[], hoursPhrase: string): string;
  atSeconds(secs: number[]): string;
  onTheHour: string;
  between(a: string, b: string): string;
  duringHours(hours: number[]): string;
  hourGroup(hours: number[]): string; // "hour 9" / "hours 9, 12 and 15"
  hourRange(a: number, b: number): string; // "hours 9 through 17"
  everyNHours(n: number): string;
  weekdayList(days: number[]): string; // días ya ordenados lunes-primero
  weekdayRange(a: number, b: number): string;
  nthWeekday(n: number, dow: number): string;
  lastWeekdayOfMonth(dow: number): string;
  domDays(days: number[]): string;
  domRange(a: number, b: number): string;
  lastDay: string;
  lastWorkday: string;
  nearestWorkday(d: number): string;
  inMonths(list: string): string;
  monthRange(a: string, b: string): string;
  or: string;
  everyDay: string;
  time(h: number, m: number, hour12: boolean): string;
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ES_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ES_DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const pad = (n: number) => String(n).padStart(2, '0');

const time12 = (h: number, m: number, suffix: [string, string]) => `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? suffix[0] : suffix[1]}`;

const EN: Words = {
  join: (xs) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`),
  through: (a, b) => `${a} through ${b}`,
  months: EN_MONTHS,
  weekdays: EN_DAYS,
  ordinal: ['first', 'second', 'third', 'fourth', 'fifth'],
  every: (n, u) => `every ${n} ${u}s`,
  everyOne: { second: 'every second', minute: 'every minute', hour: 'every hour', day: 'every day', month: 'every month' },
  atTimes: (t) => `At ${EN.join(t)}`,
  atMinutes: (mins, hp) => `At minute${mins.length > 1 ? 's' : ''} ${EN.join(mins.map(String))} past ${hp}`,
  atSeconds: (s) => `At second${s.length > 1 ? 's' : ''} ${EN.join(s.map(String))}`,
  onTheHour: 'Every hour, on the hour',
  between: (a, b) => `between ${a} and ${b}`,
  duringHours: (h) => `during ${EN.hourGroup(h)}`,
  hourGroup: (h) => `${h.length > 1 ? 'hours' : 'hour'} ${EN.join(h.map(String))}`,
  hourRange: (a, b) => `hours ${a} through ${b}`,
  everyNHours: (n) => `every ${n} hours`,
  weekdayList: (d) => `on ${EN.join(d.map((x) => EN_DAYS[x]!))}`,
  weekdayRange: (a, b) => `on ${EN.through(EN_DAYS[a]!, EN_DAYS[b]!)}`,
  nthWeekday: (n, dow) => `on the ${EN.ordinal[n - 1]} ${EN_DAYS[dow]} of the month`,
  lastWeekdayOfMonth: (dow) => `on the last ${EN_DAYS[dow]} of the month`,
  domDays: (d) => `on day${d.length > 1 ? 's' : ''} ${EN.join(d.map(String))} of the month`,
  domRange: (a, b) => `on days ${a} through ${b} of the month`,
  lastDay: 'on the last day of the month',
  lastWorkday: 'on the last weekday of the month',
  nearestWorkday: (d) => `on the weekday nearest day ${d} of the month`,
  inMonths: (l) => `in ${l}`,
  monthRange: (a, b) => `${a} through ${b}`,
  or: 'or',
  everyDay: 'every day',
  time: (h, m, h12) => (h12 ? time12(h, m, ['AM', 'PM']) : `${pad(h)}:${pad(m)}`),
};

const ES: Words = {
  join: (xs) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}`),
  through: (a, b) => `de ${a} a ${b}`,
  months: ES_MONTHS,
  weekdays: ES_DAYS,
  ordinal: ['primer', 'segundo', 'tercer', 'cuarto', 'quinto'],
  every: (n, u) => `cada ${n} ${{ second: 'segundos', minute: 'minutos', hour: 'horas', day: 'días', month: 'meses' }[u]}`,
  everyOne: { second: 'cada segundo', minute: 'cada minuto', hour: 'cada hora', day: 'cada día', month: 'cada mes' },
  atTimes: (t) => `${/^0?1:/.test(t[0]!) && t.length === 1 ? 'A la' : 'A las'} ${ES.join(t)}`,
  atMinutes: (mins, hp) => `En ${mins.length > 1 ? 'los minutos' : 'el minuto'} ${ES.join(mins.map(String))} de ${hp}`,
  atSeconds: (s) => `En ${s.length > 1 ? 'los segundos' : 'el segundo'} ${ES.join(s.map(String))}`,
  onTheHour: 'Cada hora, en punto',
  between: (a, b) => `entre las ${a} y las ${b}`,
  duringHours: (h) => `durante ${ES.hourGroup(h)}`,
  hourGroup: (h) => `${h.length > 1 ? 'las horas' : 'la hora'} ${ES.join(h.map(String))}`,
  hourRange: (a, b) => `las horas de ${a} a ${b}`,
  everyNHours: (n) => `cada ${n} horas`,
  weekdayList: (d) => `los ${ES.join(d.map((x) => ES_DAYS[x]! + (ES_DAYS[x]!.endsWith('s') ? '' : 's')))}`,
  weekdayRange: (a, b) => `de ${ES_DAYS[a]} a ${ES_DAYS[b]}`,
  nthWeekday: (n, dow) => `el ${ES.ordinal[n - 1]} ${ES_DAYS[dow]} del mes`,
  lastWeekdayOfMonth: (dow) => `el último ${ES_DAYS[dow]} del mes`,
  domDays: (d) => `${d.length > 1 ? 'los días' : 'el día'} ${ES.join(d.map(String))} del mes`,
  domRange: (a, b) => `los días ${a} a ${b} del mes`,
  lastDay: 'el último día del mes',
  lastWorkday: 'el último día laborable del mes',
  nearestWorkday: (d) => `el día laborable más cercano al día ${d} del mes`,
  // un único rango ya lleva su preposición ("de enero a marzo"); una lista de meses sueltos usa "en"
  inMonths: (l) => (l.startsWith('de ') ? l : `en ${l}`),
  monthRange: (a, b) => `de ${a} a ${b}`,
  or: 'o',
  everyDay: 'todos los días',
  time: (h, m, h12) => (h12 ? time12(h, m, ['a. m.', 'p. m.']) : `${pad(h)}:${pad(m)}`),
};

const LOCALES: Record<Locale, Words> = { en: EN, es: ES };

// ------------------------------------------------------------------ generación
/** Lista de enteros con tramos: [1,2,3,7] → "1 through 3 and 7" (solo comprime tramos de 3 o más). */
function compress(values: number[], w: Words, fmt: (n: number) => string = String): string {
  const parts = runs(values).flatMap(([a, b]) => (b - a >= 2 ? [w.through(fmt(a), fmt(b))] : full(a, b).map(fmt)));
  return w.join(parts);
}

function secondsPhrase(p: ParsedCron, w: Words): { phrase: string | null; implied: boolean } {
  if (!p.hasSeconds) return { phrase: null, implied: false };
  const s = p.seconds;
  if (s.values.length === 1 && s.values[0] === 0) return { phrase: null, implied: false };
  if (isAll(s, 0, 59)) return { phrase: cap(w.everyOne.second), implied: true };
  const n = stepOf(s.values, 0, 59);
  if (n) return { phrase: cap(w.every(n, 'second')), implied: true };
  return { phrase: w.atSeconds(s.values), implied: true };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function timePhrase(p: ParsedCron, w: Words, hour12: boolean): { text: string; specific: boolean } {
  const M = p.minutes;
  const H = p.hours;
  const mAll = isAll(M, 0, 59);
  const mStep = stepOf(M.values, 0, 59);
  const hAll = isAll(H, 0, 23);
  const hStep = stepOf(H.values, 0, 23);
  const hoursRange = isRange(H.values);
  const t = (h: number, m: number) => w.time(h, m, hour12);

  // minuto "libre" (cada minuto / cada n minutos)
  if (mAll || mStep) {
    const base = mAll ? cap(w.everyOne.minute) : cap(w.every(mStep!, 'minute'));
    if (hAll) return { text: base, specific: false };
    if (hStep) return { text: `${base}, ${w.everyNHours(hStep)}`, specific: false };
    if (hoursRange) return { text: `${base}, ${w.between(t(H.values[0]!, 0), t(H.values.at(-1)!, 59))}`, specific: false };
    return { text: `${base}, ${w.duringHours(H.values)}`, specific: false };
  }

  // minutos concretos
  if (hAll) {
    if (M.values.length === 1 && M.values[0] === 0) return { text: w.onTheHour, specific: false };
    return { text: w.atMinutes(M.values, w.everyOne.hour), specific: false };
  }
  if (hStep) return { text: w.atMinutes(M.values, w.everyNHours(hStep)), specific: false };

  const combos = M.values.length * H.values.length;
  if (combos <= 6) {
    const times = H.values.flatMap((h) => M.values.map((m) => t(h, m)));
    return { text: w.atTimes(times), specific: true };
  }
  if (M.values.length === 1 && isRange(H.values) && H.values.length >= 3) {
    const lead = M.values[0] === 0 ? w.onTheHour : w.atMinutes(M.values, w.everyOne.hour);
    return { text: `${lead}, ${w.between(t(H.values[0]!, M.values[0]!), t(H.values.at(-1)!, M.values[0]!))}`, specific: false };
  }
  const hp = isRange(H.values) && H.values.length >= 3 ? w.hourRange(H.values[0]!, H.values.at(-1)!) : w.hourGroup(H.values);
  return { text: w.atMinutes(M.values, hp), specific: false };
}

function dayPhrase(p: ParsedCron, w: Words): { dom: string | null; dow: string | null } {
  const { dom, dow } = p;
  let domText: string | null = null;
  const domParts: string[] = [];
  // "Restringido" se decide por los VALORES, no por el texto: `*/2` empieza por `*` pero solo cubre la mitad de los días.
  const domRestricted = dom.values.length < 31 || dom.last || dom.lastWeekday || dom.nearest.length > 0;
  if (domRestricted) {
    if (dom.last) domParts.push(w.lastDay);
    if (dom.lastWeekday) domParts.push(w.lastWorkday);
    for (const n of dom.nearest) domParts.push(w.nearestWorkday(n));
    if (dom.values.length && dom.values.length < 31) {
      const step = stepOf(dom.values.map((v) => v - 1), 0, 30);
      if (dom.star && step) domParts.push(w.every(step, 'day'));
      else if (isRange(dom.values) && dom.values.length >= 3) domParts.push(w.domRange(dom.values[0]!, dom.values.at(-1)!));
      else domParts.push(w.domDays(dom.values));
    }
    domText = domParts.join(` ${w.or} `);
  }

  const dowParts: string[] = [];
  const dowRestricted = dow.values.length < 7 || dow.nth.length > 0 || dow.last.length > 0;
  if (dowRestricted) {
    if (dow.values.length && !isAll(dow, 0, 6)) {
      // orden lunes-primero: el domingo (0) va al final para que "sábado y domingo" sea consecutivo
      const days = [...dow.values].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));
      const seq = days.map((d) => (d === 0 ? 7 : d));
      const rs = runs(seq);
      if (rs.length === 1 && days.length >= 3) dowParts.push(w.weekdayRange(days[0]!, days.at(-1)!));
      else dowParts.push(w.weekdayList(days));
    }
    for (const x of dow.nth) dowParts.push(w.nthWeekday(x.n, x.dow));
    for (const x of dow.last) dowParts.push(w.lastWeekdayOfMonth(x));
  }
  return { dom: domText, dow: dowParts.length ? dowParts.join(` ${w.or} `) : null };
}

function monthPhrase(p: ParsedCron, w: Words): string | null {
  const M = p.months;
  if (isAll(M, 1, 12)) return null;
  const step = stepOf(M.values.map((v) => v - 1), 0, 11);
  if (M.star && step) return w.every(step, 'month');
  const parts = runs(M.values).flatMap(([a, b]) =>
    b - a >= 2 ? [w.monthRange(w.months[a - 1]!, w.months[b - 1]!)] : full(a, b).map((m) => w.months[m - 1]!),
  );
  return w.inMonths(w.join(parts));
}

/** Descripción en lenguaje natural de una expresión ya analizada. */
export function explainCron(p: ParsedCron, opts: ExplainOptions = {}): string {
  const w = LOCALES[opts.locale ?? 'en'];
  const hour12 = opts.hour12 ?? false;
  const sec = secondsPhrase(p, w);
  const time = timePhrase(p, w, hour12);
  const day = dayPhrase(p, w);
  const month = monthPhrase(p, w);

  let head = time.text;
  if (sec.phrase) head = p.minutes.values.length === 60 && p.hours.values.length === 24 ? sec.phrase : `${sec.phrase}, ${lower(time.text)}`;

  const dateParts: string[] = [];
  if (day.dom && day.dow) dateParts.push(`${day.dom} ${w.or} ${day.dow}`); // regla clásica: se cumple una de las dos
  else if (day.dom) dateParts.push(day.dom);
  else if (day.dow) dateParts.push(day.dow);
  if (month) dateParts.push(month);

  if (dateParts.length === 0 && time.specific && !sec.phrase) dateParts.push(w.everyDay);
  return [head, ...dateParts].join(', ');
}
