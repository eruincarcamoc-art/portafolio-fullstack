import { describe, it, expect } from 'vitest';
import { CronParseError, parse, validate } from '../src/index.js';

const p = (e: string, o = {}) => parse(e, o).parsed;
const fail = (e: string, o = {}): CronParseError => {
  try {
    parse(e, o);
  } catch (err) {
    expect(err).toBeInstanceOf(CronParseError);
    return err as CronParseError;
  }
  throw new Error(`expected "${e}" to fail`);
};
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('valid syntax', () => {
  it('expands wildcards, lists, ranges and steps', () => {
    expect(p('*/15 * * * *').minutes.values).toEqual([0, 15, 30, 45]);
    expect(p('5,10,15 * * * *').minutes.values).toEqual([5, 10, 15]);
    expect(p('10-20/5 * * * *').minutes.values).toEqual([10, 15, 20]);
    expect(p('5/15 * * * *').minutes.values).toEqual([5, 20, 35, 50]); // "a/n" = a-max/n
    expect(p('* */6 * * *').hours.values).toEqual([0, 6, 12, 18]);
    expect(p('* * 1-5,20 * *').dom.values).toEqual([1, 2, 3, 4, 5, 20]);
    expect(p('* * * 1-12/3 *').months.values).toEqual([1, 4, 7, 10]);
  });

  it('sorts and de-duplicates values', () => {
    expect(p('30,5,5,10-12,11 * * * *').minutes.values).toEqual([5, 10, 11, 12, 30]);
  });

  it('accepts names, case-insensitively, in months and weekdays', () => {
    expect(p('0 0 * jan,Mar,DEC *').months.values).toEqual([1, 3, 12]);
    expect(p('0 0 * * MON-FRI').dow.values).toEqual([1, 2, 3, 4, 5]);
    expect(p('0 0 * * sat,sun').dow.values).toEqual([0, 6]);
    expect(p('0 0 * JAN-MAR *').months.values).toEqual([1, 2, 3]);
  });

  it('treats 7 as Sunday and keeps ranges that end at 7', () => {
    expect(p('0 0 * * 7').dow.values).toEqual([0]);
    expect(p('0 0 * * 5-7').dow.values).toEqual([0, 5, 6]);
    expect(p('0 0 * * 0,7').dow.values).toEqual([0]);
  });

  it('supports "?" in the day fields and flags them as wildcards', () => {
    expect(p('0 0 ? * 1').dom.star).toBe(true);
    expect(p('0 0 1 * ?').dow.star).toBe(true);
    expect(p('0 0 */2 * 1').dom.star).toBe(true); // "*/n" cuenta como comodín (regla de Vixie)
    expect(p('0 0 1 * 1').dom.star).toBe(false);
  });

  it('expands macros', () => {
    expect(parse('@daily').expression).toBe('0 0 * * *');
    expect(parse('@midnight').expression).toBe('0 0 * * *');
    expect(parse('@hourly').expression).toBe('0 * * * *');
    expect(parse('@weekly').expression).toBe('0 0 * * 0');
    expect(parse('@monthly').expression).toBe('0 0 1 * *');
    expect(parse('@yearly').expression).toBe('0 0 1 1 *');
    expect(parse('@ANNUALLY').expression).toBe('0 0 1 1 *');
    expect(parse('@daily', { seconds: true }).expression).toBe('0 0 0 * * *');
  });

  it('tolerates extra whitespace and normalises it', () => {
    expect(parse('  */5   *  * *\t* ').expression).toBe('*/5 * * * *');
  });

  it('parses an optional leading seconds field', () => {
    const s = p('*/10 30 9 * * *', { seconds: true });
    expect(s.seconds.values).toEqual([0, 10, 20, 30, 40, 50]);
    expect(s.minutes.values).toEqual([30]);
    expect(s.hasSeconds).toBe(true);
    expect(p('0 0 * * *').seconds.values).toEqual([0]);
  });

  it('parses the Quartz-style extensions L, LW, nW, n#k, nL', () => {
    expect(p('0 0 L * *').dom.last).toBe(true);
    expect(p('0 0 LW * *').dom.lastWeekday).toBe(true);
    expect(p('0 0 15W,1W * *').dom.nearest).toEqual([15, 1]);
    expect(p('0 0 * * 5#3').dow.nth).toEqual([{ dow: 5, n: 3 }]);
    expect(p('0 0 * * FRI#1,MON#5').dow.nth).toEqual([{ dow: 5, n: 1 }, { dow: 1, n: 5 }]);
    expect(p('0 0 * * 5L').dow.last).toEqual([5]);
    expect(p('0 0 * * FRIL').dow.last).toEqual([5]);
    expect(p('0 0 L * *').usesExtended).toBe(true);
    expect(p('0 0 1 * *').usesExtended).toBe(false);
  });

  it('covers every value of every field', () => {
    expect(p('* * * * *').minutes.values).toEqual(range(0, 59));
    expect(p('* * * * *').hours.values).toEqual(range(0, 23));
    expect(p('* * * * *').dom.values).toEqual(range(1, 31));
    expect(p('* * * * *').months.values).toEqual(range(1, 12));
    expect(p('* * * * *').dow.values).toEqual(range(0, 6));
  });
});

describe('errors point at the exact fragment and suggest a fix', () => {
  it('out-of-range values: reports field, position and a hint', () => {
    const e = fail('*/5 61 * * *');
    expect(e.field).toBe('hour');
    expect(e.message).toMatch(/61.*out of range \(0-23\)/);
    expect([e.start, e.end]).toEqual([4, 6]);
    expect(fail('60 * * * *').hint).toMatch(/0 to 59/);
    expect(fail('* 24 * * *').hint).toMatch(/midnight/);
    expect(fail('* * 0 * *').message).toMatch(/1-31/);
    expect(fail('* * * 13 *').message).toMatch(/1-12/);
    expect(fail('* * * * 8').hint).toMatch(/0 \(Sunday\)/);
  });

  it('locates the error inside a long list/range, not just the field', () => {
    const e = fail('0 9,17,25 * * *');
    expect([e.start, e.end]).toEqual([7, 9]);
    const r = fail('0 0 * * 1-9');
    expect(r.start).toBe(10); // el "9" del rango
  });

  it('explains steps of zero and steps larger than the range', () => {
    expect(fail('*/0 * * * *').hint).toMatch(/\*\/0/);
    expect(fail('*/70 * * * *').message).toMatch(/larger than the range/);
    expect(fail('1-5/x * * * *').message).toMatch(/not a number/);
    expect(fail('1/2/3 * * * *').message).toMatch(/only one/);
  });

  it('rejects wrap-around ranges and tells how to write them', () => {
    const e = fail('0 22-2 * * *');
    expect(e.message).toMatch(/range start 22 is greater than range end 2/);
    expect(e.hint).toBe('ranges cannot wrap around; write it as a list: 22-23,0-2');
    expect(fail('0 0 * * FRI-MON').hint).toMatch(/list/);
  });

  it('suggests close names for typos', () => {
    const e = fail('0 0 * JANUARY *');
    expect(e.message).toMatch(/unknown name "JANUARY"/);
    expect(e.hint).toMatch(/did you mean JAN/);
    expect(fail('0 0 * * MONDAY').hint).toMatch(/MON/);
  });

  it('flags malformed lists and ranges', () => {
    expect(fail('1,,2 * * * *').message).toMatch(/empty list item/);
    expect(fail('1, * * * *').message).toMatch(/empty list item/);
    expect(fail('5- * * * *').message).toMatch(/malformed range/);
    expect(fail('1-2-3 * * * *').message).toMatch(/malformed range/);
    expect(fail('x * * * *').message).toMatch(/not a valid minute value/);
  });

  it('counts fields and suggests the likely intent', () => {
    expect(fail('* * * *').message).toBe('expected 5 fields but found 4');
    const six = fail('0 */5 * * * *');
    expect(six.message).toMatch(/found 6/);
    expect(six.hint).toMatch(/seconds: true/);
    expect(fail('* * * * * * *').hint).toMatch(/year/);
    expect(fail('', {}).message).toMatch(/empty/);
    expect(fail('   ').message).toMatch(/empty/);
    expect(() => parse('* * * * *', { seconds: true })).toThrow(/expected 6 fields/);
  });

  it('handles macros: unknown, @reboot, near-misses', () => {
    expect(fail('@reboot').message).toMatch(/not time-based/);
    expect(fail('@dayly').hint).toMatch(/did you mean @daily/);
    expect(fail('@foo').hint).toMatch(/supported:/);
  });

  it('restricts extensions to the right fields and validates their arguments', () => {
    expect(fail('L * * * *').message).toMatch(/only valid in the day-of-month/);
    expect(fail('* * * * 5#6').message).toMatch(/use 1 to 5/);
    expect(fail('* * * * 5#0').message).toMatch(/use 1 to 5/);
    expect(fail('0 0 32W * *').message).toMatch(/out of range/);
    expect(fail('? * * * *').message).toMatch(/only valid in the day-of-month and day-of-week/);
    expect(fail('0 0 ?/2 * *').message).toMatch(/cannot have a step/);
  });

  it('format() draws a caret under the culprit and appends the hint when there is one', () => {
    const nl = String.fromCharCode(10);
    expect(fail('*/5 61 * * *').format()).toBe(['hour: value 61 is out of range (0-23)', '  */5 61 * * *', '      ^^'].join(nl));
    expect(fail('* 24 * * *').format()).toBe(['hour: value 24 is out of range (0-23)', '  * 24 * * *', '    ^^', '  hint: hours go from 0 to 23; use 0 for midnight'].join(nl));
  });

  it('positions stay correct with leading whitespace', () => {
    const e = fail('   0 61 * * *');
    expect([e.start, e.end]).toEqual([5, 7]);
  });
});

describe('validate() never throws', () => {
  it('returns a result object for valid and invalid input, including bad time zones', () => {
    expect(validate('*/5 * * * *')).toEqual({ valid: true, normalized: '*/5 * * * *' });
    const bad = validate('61 * * * *');
    expect(bad.valid).toBe(false);
    if (!bad.valid) expect(bad.error).toMatchObject({ field: 'minute', start: 0, end: 2 });
    const tz = validate('* * * * *', { tz: 'Mars/Olympus' });
    expect(tz.valid).toBe(false);
    if (!tz.valid) expect(tz.error.message).toMatch(/Unknown time zone/);
    expect(validate(undefined as unknown as string).valid).toBe(false);
  });
});
