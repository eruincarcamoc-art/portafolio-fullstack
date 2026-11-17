#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { CronParseError, TimezoneError, lint, parse, type Locale, type ParseOptions, type Schedule } from './index.js';
import { weekday } from './calendar.js';
import { gapEnd, naive, offsetAt, toWall, wallToInstants, type Wall } from './tz.js';

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Reloj inyectable para tests. */
  now?: () => number;
  color?: boolean;
  stdin?: () => string;
}

const VERSION = '0.1.0';

const HELP = `cronwise ${VERSION} — cron expressions done right

USAGE
  cronwise <command> "<expression>" [options]

COMMANDS
  next       Show the next runs                       cronwise next "*/15 9-17 * * 1-5" -n 5
  between    List runs in a time range                cronwise between "0 9 * * 1" --from 2026-03-01 --to 2026-04-01
  explain    Describe an expression in plain language cronwise explain "0 0 1,15 * *" --locale es
  validate   Check syntax (exit code 0 = valid)       cronwise validate "61 * * * *"
  lint       Warn about valid-but-risky expressions   cronwise lint "0 0 13 * 5"

OPTIONS
  --tz <zone>        IANA time zone, e.g. America/New_York   (default: UTC)
  --seconds          The expression has 6 fields; the first is seconds
  --dst <shift|skip> Nonexistent local time at a DST gap     (default: shift)
  -n, --count <n>    How many runs 'next' shows              (default: 5)
  --from <time>      Start: ISO 8601, epoch ms, or 'now'. A time without offset is read in --tz
  --to <time>        End of range for 'between'
  --locale <en|es>   Language of 'explain'                   (default: en)
  --12h              12-hour clock in explanations
  --json             Machine-readable output
  --no-color         Disable colors (also: NO_COLOR env var)
  -h, --help         Show this help
  -v, --version      Show version

READING FROM STDIN
  echo "*/5 * * * *" | cronwise explain -

EXIT CODES
  0 success · 1 invalid expression or arguments · 2 usage error
`;

class UsageError extends Error {}

interface Args {
  command?: string;
  expression?: string;
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['tz', 'dst', 'n', 'count', 'from', 'to', 'locale']);
const BOOL_FLAGS = new Set(['seconds', 'json', 'no-color', '12h', 'help', 'version']);
const SHORT: Record<string, string> = { n: 'count', h: 'help', v: 'version' };

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-' ) { positional.push(a); continue; }
    if (a.startsWith('-') && !/^-\d/.test(a)) {
      let name = a.replace(/^--?/, '');
      let value: string | undefined;
      const eq = name.indexOf('=');
      if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
      name = a.startsWith('--') ? name : (SHORT[name] ?? name);
      if (name === 'n') name = 'count';
      if (BOOL_FLAGS.has(name)) { flags.set(name, true); continue; }
      if (VALUE_FLAGS.has(name) || name === 'count') {
        if (value === undefined) {
          value = argv[++i];
          if (value === undefined) throw new UsageError(`option --${name} needs a value`);
        }
        flags.set(name === 'n' ? 'count' : name, value);
        continue;
      }
      throw new UsageError(`unknown option "${a}" (see --help)`);
    }
    positional.push(a);
  }
  return { command: positional[0], expression: positional[1], flags };
}

const flag = (a: Args, name: string): string | undefined => {
  const v = a.flags.get(name);
  return typeof v === 'string' ? v : undefined;
};

// ------------------------------------------------------------------ formato
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-03-09 09:00:00 -04:00 (Mon)" en la zona dada. */
export function formatInstant(ms: number, tz: string): string {
  const w = toWall(ms, tz);
  const off = offsetAt(ms, tz);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off) / 60000;
  return `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)} (${DAYS[weekday(w.y, w.mo, w.d)]})`;
}

/** Acepta ISO con/sin zona, epoch en ms o 'now'. Sin zona explícita se interpreta en `tz`. */
export function parseTime(text: string, tz: string, now: number): number {
  if (text === 'now') return now;
  if (/^\d{10,}$/.test(text)) return Number(text);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) {
    const w: Wall = { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
    if (w.mo < 1 || w.mo > 12 || w.d < 1 || w.d > 31 || w.h > 23 || w.mi > 59 || w.s > 59) throw new UsageError(`invalid date "${text}"`);
    const inst = wallToInstants(w, tz);
    return inst[0] ?? gapEnd(w, tz);
  }
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new UsageError(`cannot understand time "${text}" (use ISO 8601, e.g. 2026-03-08T09:00:00)`);
  return t;
}

const ansi = (on: boolean) => ({
  bold: (s: string) => (on ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (on ? `\x1b[2m${s}\x1b[22m` : s),
  red: (s: string) => (on ? `\x1b[31m${s}\x1b[39m` : s),
  yellow: (s: string) => (on ? `\x1b[33m${s}\x1b[39m` : s),
  green: (s: string) => (on ? `\x1b[32m${s}\x1b[39m` : s),
  cyan: (s: string) => (on ? `\x1b[36m${s}\x1b[39m` : s),
});

// ------------------------------------------------------------------ comandos
export function main(argv: string[], io: IO): number {
  const now = io.now ?? Date.now;
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`error: ${(e as Error).message}\n`);
    return 2;
  }
  const c = ansi((io.color ?? false) && !args.flags.has('no-color'));
  const json = args.flags.has('json');

  if (args.flags.has('version')) { io.out(`${VERSION}\n`); return 0; }
  if (args.flags.has('help') || !args.command || args.command === 'help') { io.out(HELP); return args.command || args.flags.has('help') ? 0 : 2; }

  const commands = ['next', 'between', 'explain', 'validate', 'lint'];
  if (!commands.includes(args.command)) {
    io.err(`error: unknown command "${args.command}". Commands: ${commands.join(', ')}\n`);
    return 2;
  }

  let expression = args.expression;
  if (expression === '-') expression = (io.stdin ? io.stdin() : readFileSync(0, 'utf8')).trim();
  if (!expression) { io.err(`error: missing expression. Example: cronwise ${args.command} "*/15 * * * *"\n`); return 2; }

  const tz = flag(args, 'tz') ?? 'UTC';
  const dst = flag(args, 'dst');
  if (dst !== undefined && dst !== 'shift' && dst !== 'skip') { io.err('error: --dst must be "shift" or "skip"\n'); return 2; }
  const locale = flag(args, 'locale') ?? 'en';
  if (locale !== 'en' && locale !== 'es') { io.err('error: --locale must be "en" or "es"\n'); return 2; }
  const opts: ParseOptions = { tz, seconds: args.flags.has('seconds'), dstGap: dst as 'shift' | 'skip' | undefined };

  let schedule: Schedule;
  try {
    schedule = parse(expression, opts);
  } catch (e) {
    if (e instanceof CronParseError) {
      if (json) io.out(JSON.stringify({ valid: false, error: { message: e.message, field: e.field, start: e.start, end: e.end, hint: e.hint } }, null, 2) + '\n');
      else io.err(`${c.red('error')}: ${e.format().replace(/\n/g, '\n').replace(/^(.*?)(\n)/, (_m, l, nl) => `${l}${nl}`)}\n`);
      return 1;
    }
    if (e instanceof TimezoneError) { io.err(`${c.red('error')}: ${e.message}. Use an IANA name such as Europe/Madrid or America/New_York.\n`); return 1; }
    throw e;
  }

  try {
    switch (args.command) {
      case 'validate': {
        if (json) io.out(JSON.stringify({ valid: true, normalized: schedule.expression }) + '\n');
        else io.out(`${c.green('✓')} valid: ${schedule.expression}\n`);
        return 0;
      }

      case 'explain': {
        const text = schedule.explain({ locale: locale as Locale, hour12: args.flags.has('12h') });
        if (json) io.out(JSON.stringify({ expression: schedule.expression, locale, explanation: text }) + '\n');
        else io.out(`${text}\n`);
        return 0;
      }

      case 'lint': {
        const warnings = lint(schedule);
        if (json) io.out(JSON.stringify({ expression: schedule.expression, warnings }, null, 2) + '\n');
        else if (!warnings.length) io.out(`${c.green('✓')} no issues found\n`);
        else for (const w of warnings) io.out(`${w.severity === 'error' ? c.red('error  ') : w.severity === 'warning' ? c.yellow('warning') : c.cyan('info   ')} ${c.dim(`[${w.code}]`)} ${w.message}\n`);
        return warnings.some((w) => w.severity === 'error') ? 1 : 0;
      }

      case 'next': {
        const countText = flag(args, 'count') ?? '5';
        const count = Number(countText);
        if (!Number.isInteger(count) || count < 1 || count > 1000) { io.err('error: --count must be an integer between 1 and 1000\n'); return 2; }
        const from = parseTime(flag(args, 'from') ?? 'now', tz, now());
        const runs = schedule.nextRuns(count, from);
        if (json) {
          io.out(JSON.stringify({ expression: schedule.expression, timezone: tz, explanation: schedule.explain({ locale: locale as Locale }), from: new Date(from).toISOString(), runs: runs.map((d) => d.toISOString()) }, null, 2) + '\n');
          return 0;
        }
        io.out(`${c.bold(schedule.expression)}  ${c.dim(`— ${schedule.explain({ locale: locale as Locale })} (${tz})`)}\n`);
        if (!runs.length) { io.out(`${c.yellow('this expression never runs')} (no matching date in the next 9 years)\n`); return 1; }
        runs.forEach((d, i) => io.out(`${c.dim(String(i + 1).padStart(String(runs.length).length) + '.')} ${formatInstant(+d, tz)}\n`));
        return 0;
      }

      case 'between': {
        const fromText = flag(args, 'from');
        const toText = flag(args, 'to');
        if (!fromText || !toText) { io.err('error: "between" needs --from and --to\n'); return 2; }
        const from = parseTime(fromText, tz, now());
        const to = parseTime(toText, tz, now());
        if (to <= from) { io.err('error: --to must be after --from\n'); return 2; }
        const limit = 1000;
        const runs = schedule.between(from, to, { limit: limit + 1 });
        const truncated = runs.length > limit;
        const shown = truncated ? runs.slice(0, limit) : runs;
        if (json) io.out(JSON.stringify({ expression: schedule.expression, timezone: tz, count: shown.length, truncated, runs: shown.map((d) => d.toISOString()) }, null, 2) + '\n');
        else {
          for (const d of shown) io.out(`${formatInstant(+d, tz)}\n`);
          io.out(c.dim(`${shown.length}${truncated ? '+' : ''} run(s) between ${formatInstant(from, tz).slice(0, 19)} and ${formatInstant(to, tz).slice(0, 19)}${truncated ? ` (output limited to ${limit})` : ''}\n`));
        }
        return 0;
      }
    }
  } catch (e) {
    if (e instanceof UsageError) { io.err(`error: ${e.message}\n`); return 2; }
    throw e;
  }
  return 0;
}

// Punto de entrada del binario (no se ejecuta al importar el módulo en tests).
const isMain = typeof process !== 'undefined' && process.argv[1] && /cli\.(js|ts|cjs|mjs)$/.test(process.argv[1]);
if (isMain && !process.env.CRONWISE_NO_AUTORUN) {
  const code = main(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  });
  process.exitCode = code;
}

void naive;
