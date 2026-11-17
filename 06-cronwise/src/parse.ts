import { CronParseError, type FieldName } from './errors.js';
import type { DomSpec, DowSpec, FieldSpec, ParsedCron } from './types.js';

export const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldDef {
  name: FieldName;
  min: number;
  max: number;
  names?: string[];
  nameBase?: number;
}

const FIELDS: Record<'second' | 'minute' | 'hour' | 'dom' | 'month' | 'dow', FieldDef> = {
  second: { name: 'second', min: 0, max: 59 },
  minute: { name: 'minute', min: 0, max: 59 },
  hour: { name: 'hour', min: 0, max: 23 },
  dom: { name: 'day-of-month', min: 1, max: 31 },
  month: { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  dow: { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES, nameBase: 0 },
};

type Kind = keyof typeof FIELDS;

class Ctx {
  constructor(readonly input: string) {}
  err(message: string, start: number, end: number, field: FieldName, hint?: string): never {
    throw new CronParseError(message, this.input, start, end, field, hint);
  }
}

/** Valor numérico o nombre (JAN, MON...) → número. */
function toNumber(ctx: Ctx, text: string, def: FieldDef, start: number): number {
  if (/^\d+$/.test(text)) return Number(text);
  if (def.names) {
    const i = def.names.indexOf(text.toUpperCase());
    if (i >= 0) return i + (def.nameBase ?? 0);
    if (/^[A-Za-z]+$/.test(text)) {
      const close = def.names.find((n) => n[0] === text[0]!.toUpperCase());
      ctx.err(`unknown name "${text}"`, start, start + text.length, def.name, close ? `did you mean ${close}? Valid names: ${def.names.join(', ')}` : `valid names: ${def.names.join(', ')}`);
    }
  }
  return ctx.err(`"${text}" is not a valid ${def.name} value`, start, start + text.length, def.name, def.names ? `use ${def.min}-${def.max === 7 ? 6 : def.max} or ${def.names.slice(0, 3).join('/')}…` : `use a number from ${def.min} to ${def.max}`);
}

function checkRange(ctx: Ctx, v: number, def: FieldDef, start: number, end: number): number {
  if (v < def.min || v > def.max) {
    const hint =
      def.name === 'minute' && v === 60 ? 'minutes go from 0 to 59' :
      def.name === 'hour' && v === 24 ? 'hours go from 0 to 23; use 0 for midnight' :
      def.name === 'day-of-week' ? 'days of the week go from 0 (Sunday) to 6 (Saturday); 7 is also Sunday' : undefined;
    ctx.err(`value ${v} is out of range (${def.min}-${def.max})`, start, end, def.name, hint);
  }
  return v;
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
}

const normDow = (v: number) => (v === 7 ? 0 : v);

interface Extras {
  last?: boolean;
  lastWeekday?: boolean;
  nearest?: number[];
  nth?: Array<{ dow: number; n: number }>;
  lastDow?: number[];
}

function parseField(ctx: Ctx, token: string, offset: number, kind: Kind): FieldSpec & Extras {
  const def = FIELDS[kind];
  const set = new Set<number>();
  const extras: Extras = {};
  let star = token.startsWith('*') || token.startsWith('?');
  let pos = 0;

  for (const item of token.split(',')) {
    const start = offset + pos;
    const end = start + item.length;
    pos += item.length + 1;
    if (item === '') ctx.err('empty list item', start, Math.max(end, start + 1), def.name, 'remove the extra comma');

    // ---- sintaxis extendida (Quartz) ----
    if (kind === 'dom') {
      if (item.toUpperCase() === 'L') { extras.last = true; continue; }
      if (item.toUpperCase() === 'LW') { extras.lastWeekday = true; continue; }
      const w = /^(\d{1,2})W$/i.exec(item);
      if (w) {
        const n = checkRange(ctx, Number(w[1]), def, start, end);
        (extras.nearest ??= []).push(n);
        continue;
      }
    }
    if (kind === 'dow') {
      const nth = /^([A-Za-z0-9]+)#(\d+)$/.exec(item);
      if (nth) {
        const dow = normDow(checkRange(ctx, toNumber(ctx, nth[1]!, def, start), def, start, end));
        const n = Number(nth[2]);
        if (n < 1 || n > 5) ctx.err(`"#${n}" is invalid: use 1 to 5 (the ${n}th occurrence does not exist)`, start, end, def.name, 'e.g. FRI#3 is the third Friday');
        (extras.nth ??= []).push({ dow, n });
        continue;
      }
      const last = /^([A-Za-z0-9]+)L$/i.exec(item);
      if (last && !/^\d+$/.test(item) && !DOW_NAMES.includes(item.toUpperCase())) {
        const dow = normDow(checkRange(ctx, toNumber(ctx, last[1]!, def, start), def, start, end));
        (extras.lastDow ??= []).push(dow);
        continue;
      }
    }
    if ((item.includes('#') || /[0-9]L$/i.test(item) || /^L/i.test(item)) && !(kind === 'dow' || kind === 'dom')) {
      ctx.err(`"${item}" is only valid in the day-of-month / day-of-week fields`, start, end, def.name);
    }

    // ---- sintaxis estándar: base[/paso] ----
    const [base = '', stepText, ...extra] = item.split('/');
    if (extra.length) ctx.err('only one "/" step is allowed', start, end, def.name);
    let step = 1;
    let stepStart = start + base.length + 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) ctx.err(`step "${stepText}" is not a number`, stepStart, end, def.name);
      step = Number(stepText);
      if (step < 1) ctx.err('step must be at least 1', stepStart, end, def.name, `"*/0" never runs; did you mean "*"?`);
    }

    let lo: number;
    let hi: number;
    if (base === '*' || (base === '?' && (kind === 'dom' || kind === 'dow'))) {
      if (base === '?' && stepText !== undefined) ctx.err('"?" cannot have a step', start, end, def.name, 'use "*/n"');
      lo = def.min;
      hi = kind === 'dow' ? 6 : def.max;
    } else if (base === '?') {
      ctx.err('"?" is only valid in the day-of-month and day-of-week fields', start, end, def.name, 'use "*"');
    } else if (base.includes('-')) {
      const [a, b, ...more] = base.split('-');
      if (more.length || a === '' || b === '') ctx.err(`malformed range "${base}"`, start, start + base.length, def.name, 'ranges look like 1-5');
      const aStart = start;
      const bStart = start + a!.length + 1;
      lo = checkRange(ctx, toNumber(ctx, a!, def, aStart), def, aStart, aStart + a!.length);
      hi = checkRange(ctx, toNumber(ctx, b!, def, bStart), def, bStart, bStart + b!.length);
      if (lo > hi) {
        const wrap = `${lo}-${def.max === 7 ? 6 : def.max},${def.min}-${hi}`;
        ctx.err(`range start ${lo} is greater than range end ${hi}`, start, start + base.length, def.name, `ranges cannot wrap around; write it as a list: ${wrap}`);
      }
    } else {
      lo = checkRange(ctx, toNumber(ctx, base, def, start), def, start, start + base.length);
      hi = stepText !== undefined ? (kind === 'dow' ? 6 : def.max) : lo; // "5/15" = 5-59/15
    }

    const span = hi - lo + 1;
    if (step > Math.max(span, 1) && stepText !== undefined && (base === '*' || base.includes('-'))) {
      ctx.err(`step ${step} is larger than the range (${span} values)`, stepStart, end, def.name, `"*/${step}" would only match ${lo}`);
    }
    for (const v of range(lo, hi, step)) set.add(kind === 'dow' ? normDow(v) : v);
  }

  return { values: [...set].sort((a, b) => a - b), star, raw: token, ...extras };
}

export interface ParseInternalOptions {
  seconds: boolean;
}

export function parseExpression(input: string, opts: ParseInternalOptions): ParsedCron {
  const trimmedStart = input.length - input.trimStart().length;
  const text = input.trim();
  if (text === '') throw new CronParseError('expression is empty', input, 0, 1, undefined, 'e.g. "*/15 * * * *" (every 15 minutes)');

  let source = text;
  if (text.startsWith('@')) {
    const macro = MACROS[text.toLowerCase()];
    if (!macro) {
      const near = Object.keys(MACROS).find((m) => m.slice(0, 3) === text.toLowerCase().slice(0, 3));
      throw new CronParseError(text.toLowerCase() === '@reboot' ? '@reboot cannot be scheduled (it is not time-based)' : `unknown macro "${text}"`, input, trimmedStart, trimmedStart + text.length, undefined, near ? `did you mean ${near}?` : `supported: ${Object.keys(MACROS).join(', ')}`);
    }
    // Las macros son de 5 campos: con segundos se les antepone "0".
    const expanded = opts.seconds ? `0 ${macro}` : macro;
    const parsed = parseTokens(expanded, expanded, opts, 0);
    return parsed;
  }

  return parseTokens(text, input, opts, trimmedStart);
}

function parseTokens(text: string, originalInput: string, opts: ParseInternalOptions, baseOffset: number): ParsedCron {
  const ctx = new Ctx(originalInput);
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: baseOffset + m.index! }));
  const expected = opts.seconds ? 6 : 5;

  if (tokens.length !== expected) {
    const at = tokens.length > expected ? tokens[expected]!.start : Math.max(0, originalInput.length);
    let hint: string | undefined;
    if (tokens.length === 6 && !opts.seconds) hint = 'this looks like a 6-field expression with seconds; pass { seconds: true } (CLI: --seconds)';
    else if (tokens.length === 7) hint = 'year fields are not supported';
    else if (tokens.length < expected) hint = `expected: ${opts.seconds ? 'second ' : ''}minute hour day-of-month month day-of-week`;
    throw new CronParseError(
      `expected ${expected} fields but found ${tokens.length}`, originalInput, tokens.length > expected ? at : 0,
      tokens.length > expected ? originalInput.length : Math.max(1, originalInput.trimEnd().length), undefined, hint,
    );
  }

  const kinds: Kind[] = opts.seconds ? ['second', 'minute', 'hour', 'dom', 'month', 'dow'] : ['minute', 'hour', 'dom', 'month', 'dow'];
  const specs = kinds.map((k, i) => ({ kind: k, spec: parseField(ctx, tokens[i]!.text, tokens[i]!.start, k) }));
  const by = (k: Kind) => specs.find((s) => s.kind === k)?.spec;

  const dom = by('dom')!;
  const dow = by('dow')!;
  const domSpec: DomSpec = { values: dom.values, star: dom.star, raw: dom.raw, last: dom.last ?? false, lastWeekday: dom.lastWeekday ?? false, nearest: dom.nearest ?? [] };
  const dowSpec: DowSpec = { values: dow.values, star: dow.star, raw: dow.raw, nth: dow.nth ?? [], last: dow.lastDow ?? [] };
  const usesExtended = domSpec.last || domSpec.lastWeekday || domSpec.nearest.length > 0 || dowSpec.nth.length > 0 || dowSpec.last.length > 0;

  return {
    seconds: by('second') ?? { values: [0], star: false, raw: '0' },
    minutes: by('minute')!,
    hours: by('hour')!,
    dom: domSpec,
    months: by('month')!,
    dow: dowSpec,
    expression: tokens.map((t) => t.text).join(' '),
    usesExtended,
    hasSeconds: opts.seconds,
  };
}
