import { describe, it, expect } from 'vitest';
import { explain, lint, parse } from '../src/index.js';
import { formatInstant, main, parseTime } from '../src/cli.js';

describe('explain (English)', () => {
  const cases: Array<[string, string]> = [
    ['* * * * *', 'Every minute'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['0 * * * *', 'Every hour, on the hour'],
    ['30 * * * *', 'At minute 30 past every hour'],
    ['5,20 * * * *', 'At minutes 5 and 20 past every hour'],
    ['5/15 * * * *', 'At minutes 5, 20, 35 and 50 past every hour'],
    ['0 9 * * *', 'At 09:00, every day'],
    ['30 9 * * 1-5', 'At 09:30, on Monday through Friday'],
    ['0 9,17 * * *', 'At 09:00 and 17:00, every day'],
    ['0 9,12,17 * * 1', 'At 09:00, 12:00 and 17:00, on Monday'],
    ['*/15 9-17 * * 1-5', 'Every 15 minutes, between 09:00 and 17:59, on Monday through Friday'],
    ['* 9-17 * * *', 'Every minute, between 09:00 and 17:59'],
    ['0 9-17 * * 1-5', 'Every hour, on the hour, between 09:00 and 17:00, on Monday through Friday'],
    ['30 9-17 * * *', 'At minute 30 past every hour, between 09:30 and 17:30'],
    ['0 */2 * * *', 'At minute 0 past every 2 hours'],
    ['*/10 */3 * * *', 'Every 10 minutes, every 3 hours'],
    ['0 0 1 * *', 'At 00:00, on day 1 of the month'],
    ['0 0 1,15 * *', 'At 00:00, on days 1 and 15 of the month'],
    ['0 0 1-7 * *', 'At 00:00, on days 1 through 7 of the month'],
    ['0 0 */2 * *', 'At 00:00, every 2 days'],
    ['0 0 * * */2', 'At 00:00, on Tuesday, Thursday, Saturday and Sunday'], // semana de lunes a domingo: el domingo va al final
    ['0 0 * * 0-6', 'At 00:00, every day'],
    ['0 0 * * 0', 'At 00:00, on Sunday'],
    ['0 0 * * 6,0', 'At 00:00, on Saturday and Sunday'],
    ['0 0 * * 1,3,5', 'At 00:00, on Monday, Wednesday and Friday'],
    ['0 0 1 1 *', 'At 00:00, on day 1 of the month, in January'],
    ['0 12 * 1-3 *', 'At 12:00, in January through March'],
    ['0 12 * 1,4,7 *', 'At 12:00, in January, April and July'],
    ['0 12 * */3 *', 'At 12:00, every 3 months'],
    ['0 0 L * *', 'At 00:00, on the last day of the month'],
    ['0 0 LW * *', 'At 00:00, on the last weekday of the month'],
    ['0 0 15W * *', 'At 00:00, on the weekday nearest day 15 of the month'],
    ['0 0 * * 5#3', 'At 00:00, on the third Friday of the month'],
    ['0 0 * * 5L', 'At 00:00, on the last Friday of the month'],
    ['0 0 13 * 5', 'At 00:00, on day 13 of the month or on Friday'], // semántica OR visible en la explicación
    ['@daily', 'At 00:00, every day'],
    ['@weekly', 'At 00:00, on Sunday'],
  ];
  it.each(cases)('%s → %s', (expr, text) => {
    expect(explain(expr)).toBe(text);
  });

  it('describes seconds', () => {
    expect(explain('*/20 * * * * *', { seconds: true })).toBe('Every 20 seconds');
    expect(explain('* * * * * *', { seconds: true })).toBe('Every second');
    expect(explain('30 */5 * * * *', { seconds: true })).toBe('At second 30, every 5 minutes');
    expect(explain('0 30 9 * * *', { seconds: true })).toBe('At 09:30, every day'); // segundo 0 = implícito
  });

  it('supports a 12-hour clock', () => {
    expect(explain('30 15 * * *', { hour12: true })).toBe('At 3:30 PM, every day');
    expect(explain('0 0 * * *', { hour12: true })).toBe('At 12:00 AM, every day');
    expect(explain('0 12 * * *', { hour12: true })).toBe('At 12:00 PM, every day');
    expect(explain('0 9-17 * * *', { hour12: true })).toBe('Every hour, on the hour, between 9:00 AM and 5:00 PM');
  });
});

describe('explain (español)', () => {
  const cases: Array<[string, string]> = [
    ['* * * * *', 'Cada minuto'],
    ['*/15 * * * *', 'Cada 15 minutos'],
    ['0 * * * *', 'Cada hora, en punto'],
    ['5,20 * * * *', 'En los minutos 5 y 20 de cada hora'],
    ['0 9 * * 1-5', 'A las 09:00, de lunes a viernes'],
    ['0 1 * * *', 'A la 01:00, todos los días'],
    ['0 9,17 * * *', 'A las 09:00 y 17:00, todos los días'],
    ['*/15 9-17 * * 1-5', 'Cada 15 minutos, entre las 09:00 y las 17:59, de lunes a viernes'],
    ['0 0 1 * *', 'A las 00:00, el día 1 del mes'],
    ['0 0 1,15 * *', 'A las 00:00, los días 1 y 15 del mes'],
    ['0 0 * * 6,0', 'A las 00:00, los sábados y domingos'],
    ['0 0 * * 1,3,5', 'A las 00:00, los lunes, miércoles y viernes'],
    ['0 0 1 1 *', 'A las 00:00, el día 1 del mes, en enero'],
    ['0 12 * 1-3 *', 'A las 12:00, de enero a marzo'],
    ['0 0 L * *', 'A las 00:00, el último día del mes'],
    ['0 0 * * 5#3', 'A las 00:00, el tercer viernes del mes'],
    ['0 0 13 * 5', 'A las 00:00, el día 13 del mes o los viernes'],
  ];
  it.each(cases)('%s → %s', (expr, text) => {
    expect(explain(expr, { locale: 'es' })).toBe(text);
  });
});

describe('lint', () => {
  const codes = (e: string, o = {}) => lint(e, o).map((w) => w.code);

  it('flags schedules that never run (as an error)', () => {
    const w = lint('0 0 30 2 *');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'never-runs', severity: 'error' });
    expect(codes('0 0 31 4 *')).toEqual(['never-runs']);
  });

  it('warns about the day-of-month / day-of-week OR trap, with a concrete example', () => {
    const w = lint('0 0 13 * 5').find((x) => x.code === 'dom-dow-or')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toMatch(/EITHER/);
    expect(codes('0 0 13 * *')).not.toContain('dom-dow-or');
    expect(codes('0 0 * * 5')).not.toContain('dom-dow-or');
  });

  it('reports high frequency', () => {
    expect(codes('* * * * *')).toContain('every-minute');
    expect(codes('*/10 * * * * *', { seconds: true })).toContain('high-frequency'); // 8 640 veces al día
    expect(codes('0 */5 * * * *', { seconds: true })).toEqual([]); // cada 5 minutos: normal
    expect(codes('* * * * * *', { seconds: true })).toContain('high-frequency');
    expect(codes('*/2 * * * *')).toContain('high-frequency');
    expect(codes('*/15 * * * *')).toEqual([]);
  });

  it('notes non-portable extensions and day-31 schedules that skip short months', () => {
    expect(codes('0 0 L * *')).toEqual(['non-portable']);
    expect(codes('0 0 * * 5#2')).toEqual(['non-portable']);
    expect(codes('0 0 31 * *')).toEqual(['skips-short-months']);
    expect(codes('0 0 29-31 * *')).toEqual(['skips-short-months']);
    expect(codes('0 0 1,31 * *')).toEqual([]);
  });

  it('warns when a fixed local time falls in the DST danger zone, but only for zones with DST', () => {
    expect(codes('30 2 * * *', { tz: 'America/New_York' })).toContain('dst-ambiguous-hour');
    expect(codes('30 2 * * *', { tz: 'Asia/Tokyo' })).not.toContain('dst-ambiguous-hour');
    expect(codes('30 2 * * *')).not.toContain('dst-ambiguous-hour'); // UTC
    expect(codes('30 9 * * *', { tz: 'America/New_York' })).not.toContain('dst-ambiguous-hour');
    expect(codes('*/10 * * * *', { tz: 'America/New_York' })).not.toContain('dst-ambiguous-hour'); // horas comodín: seguras
  });

  it('accepts an already-parsed Schedule', () => {
    expect(lint(parse('0 0 30 2 *'))[0]!.code).toBe('never-runs');
  });
});

// ------------------------------------------------------------------ CLI
function run(argv: string[], opts: { stdin?: string; now?: string } = {}) {
  let out = '';
  let err = '';
  const code = main(argv, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    now: () => Date.parse(opts.now ?? '2026-03-01T00:00:00Z'),
    color: false,
    stdin: () => opts.stdin ?? '',
  });
  return { code, out, err };
}

describe('CLI', () => {
  it('next: lists runs with offset and weekday in the requested zone', () => {
    const r = run(['next', '0 9 * * 1-5', '-n', '3', '--tz', 'America/New_York', '--from', '2026-03-06T10:00']);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toEqual([
      '0 9 * * 1-5  — At 09:00, on Monday through Friday (America/New_York)',
      '1. 2026-03-09 09:00:00 -04:00 (Mon)',
      '2. 2026-03-10 09:00:00 -04:00 (Tue)',
      '3. 2026-03-11 09:00:00 -04:00 (Wed)',
      '',
    ]);
  });

  it('next uses the injected clock when --from is omitted, and --json is machine readable', () => {
    const r = run(['next', '0 12 * * *', '-n', '2', '--json']);
    const j = JSON.parse(r.out);
    expect(j.runs).toEqual(['2026-03-01T12:00:00.000Z', '2026-03-02T12:00:00.000Z']);
    expect(j).toMatchObject({ expression: '0 12 * * *', timezone: 'UTC', explanation: 'At 12:00, every day' });
  });

  it('shows the DST shift, and --dst skip removes it', () => {
    const shift = run(['next', '30 2 * * *', '--tz', 'America/New_York', '--from', '2026-03-07T12:00', '-n', '1']);
    expect(shift.out).toContain('2026-03-08 03:00:00 -04:00 (Sun)');
    const skip = run(['next', '30 2 * * *', '--tz', 'America/New_York', '--from', '2026-03-07T12:00', '-n', '1', '--dst', 'skip']);
    expect(skip.out).toContain('2026-03-09 02:30:00 -04:00 (Mon)');
  });

  it('between: lists runs in a range and prints a count', () => {
    const r = run(['between', '0 0 * * 1', '--from', '2026-03-01', '--to', '2026-04-01']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('2026-03-02 00:00:00 +00:00 (Mon)');
    expect(r.out).toContain('2026-03-30 00:00:00 +00:00 (Mon)');
    expect(r.out).toMatch(/\n5 run\(s\) between/); // marzo de 2026 tiene 5 lunes
    expect(run(['between', '0 0 * * 1', '--from', '2026-03-01']).code).toBe(2);
    expect(run(['between', '0 0 * * 1', '--from', '2026-04-01', '--to', '2026-03-01']).code).toBe(2);
  });

  it('explain supports --locale and --12h', () => {
    expect(run(['explain', '0 9 * * 1-5', '--locale', 'es']).out).toBe('A las 09:00, de lunes a viernes\n');
    expect(run(['explain', '30 15 * * *', '--12h']).out).toBe('At 3:30 PM, every day\n');
    expect(run(['explain', '* * * * *', '--locale', 'fr']).code).toBe(2);
  });

  it('validate: exit 0 for valid, exit 1 with a caret for invalid, JSON on request', () => {
    expect(run(['validate', '*/5 * * * *'])).toMatchObject({ code: 0, out: '✓ valid: */5 * * * *\n' });
    const bad = run(['validate', '*/5 61 * * *']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('hour: value 61 is out of range (0-23)');
    expect(bad.err).toContain('  */5 61 * * *\n      ^^');
    const j = JSON.parse(run(['validate', '61 * * * *', '--json']).out);
    expect(j).toMatchObject({ valid: false, error: { field: 'minute', start: 0, end: 2 } });
  });

  it('lint: exit 1 only on errors, warnings keep exit 0', () => {
    expect(run(['lint', '0 0 13 * 5']).code).toBe(0);
    expect(run(['lint', '0 0 13 * 5']).out).toMatch(/warning \[dom-dow-or\]/);
    expect(run(['lint', '0 0 30 2 *']).code).toBe(1);
    expect(run(['lint', '*/15 * * * *']).out).toBe('✓ no issues found\n');
  });

  it('reads the expression from stdin with "-"', () => {
    expect(run(['explain', '-'], { stdin: '*/5 * * * *\n' }).out).toBe('Every 5 minutes\n');
  });

  it('usage errors exit 2 with a clear message; --help and --version exit 0', () => {
    expect(run([]).code).toBe(2);
    expect(run(['bogus', '* * * * *'])).toMatchObject({ code: 2 });
    expect(run(['next']).err).toMatch(/missing expression/);
    expect(run(['next', '* * * * *', '--wat']).err).toMatch(/unknown option "--wat"/);
    expect(run(['next', '* * * * *', '-n']).err).toMatch(/needs a value/);
    expect(run(['next', '* * * * *', '-n', '0']).code).toBe(2);
    expect(run(['next', '* * * * *', '--from', 'garbage']).code).toBe(2);
    expect(run(['next', '* * * * *', '--dst', 'later']).code).toBe(2);
    expect(run(['--help']).out).toContain('USAGE');
    expect(run(['help']).code).toBe(0);
    expect(run(['--version']).out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it('invalid zone and 6-field hint are reported helpfully', () => {
    const tz = run(['next', '* * * * *', '--tz', 'Nope/Zone']);
    expect(tz.code).toBe(1);
    expect(tz.err).toMatch(/Unknown time zone "Nope\/Zone"/);
    const six = run(['validate', '*/5 * * * * *']);
    expect(six.code).toBe(1);
    expect(six.err).toMatch(/--seconds/);
    expect(run(['validate', '*/5 * * * * *', '--seconds']).code).toBe(0);
  });

  it('a schedule that never runs says so and exits 1', () => {
    const r = run(['next', '0 0 30 2 *']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/never runs/);
  });

  it('times without an offset are read in the schedule zone (and gap times resolve to the gap end)', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(new Date(parseTime('2026-03-08T09:00:00', 'America/New_York', now)).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(new Date(parseTime('2026-03-08T02:30', 'America/New_York', now)).toISOString()).toBe('2026-03-08T07:00:00.000Z'); // hueco
    expect(new Date(parseTime('2026-11-01T01:30', 'America/New_York', now)).toISOString()).toBe('2026-11-01T05:30:00.000Z'); // solape: la primera
    expect(parseTime('2026-03-08T09:00:00Z', 'America/New_York', now)).toBe(Date.parse('2026-03-08T09:00:00Z')); // con zona explícita manda ella
    expect(parseTime('now', 'UTC', now)).toBe(now);
    expect(parseTime('1767225600000', 'UTC', now)).toBe(1767225600000);
  });

  it('formatInstant renders offset and weekday, including half-hour zones', () => {
    expect(formatInstant(Date.UTC(2026, 0, 1, 12), 'Asia/Kolkata')).toBe('2026-01-01 17:30:00 +05:30 (Thu)');
    expect(formatInstant(Date.UTC(2026, 6, 4, 12), 'America/New_York')).toBe('2026-07-04 08:00:00 -04:00 (Sat)');
  });
});
