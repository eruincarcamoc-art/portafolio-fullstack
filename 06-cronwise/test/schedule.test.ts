import { describe, it, expect } from 'vitest';
import { parse } from '../src/index.js';

const iso = (ds: Array<Date | null>) => ds.map((d) => d?.toISOString().replace('.000Z', 'Z') ?? null);
const runs = (expr: string, from: string, n: number, opts = {}) => iso(parse(expr, opts).nextRuns(n, new Date(from)));

describe('next() in UTC', () => {
  it('finds the next runs of simple schedules', () => {
    expect(runs('*/15 * * * *', '2026-01-01T00:07:30Z', 3)).toEqual(['2026-01-01T00:15:00Z', '2026-01-01T00:30:00Z', '2026-01-01T00:45:00Z']);
    expect(runs('0 9 * * 1-5', '2026-03-06T10:00:00Z', 3)).toEqual(['2026-03-09T09:00:00Z', '2026-03-10T09:00:00Z', '2026-03-11T09:00:00Z']); // viernes → lunes
    expect(runs('0 0 1 * *', '2026-01-15T00:00:00Z', 2)).toEqual(['2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z']);
    expect(runs('@yearly', '2026-06-01T00:00:00Z', 2)).toEqual(['2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z']);
  });

  it('is strictly after `from`: an exact match is not returned, 1 ms earlier is', () => {
    const s = parse('*/15 * * * *');
    expect(iso([s.next(new Date('2026-01-01T00:15:00.000Z'))])).toEqual(['2026-01-01T00:30:00Z']);
    expect(iso([s.next(new Date('2026-01-01T00:14:59.999Z'))])).toEqual(['2026-01-01T00:15:00Z']);
    expect(iso([s.next(new Date('2026-01-01T00:15:00.001Z'))])).toEqual(['2026-01-01T00:30:00Z']);
  });

  it('crosses hour, day, month and year boundaries', () => {
    expect(runs('59 23 31 12 *', '2026-12-31T23:58:00Z', 2)).toEqual(['2026-12-31T23:59:00Z', '2027-12-31T23:59:00Z']);
    expect(runs('0 0 * * *', '2026-02-27T12:00:00Z', 3)).toEqual(['2026-02-28T00:00:00Z', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z']);
  });

  it('handles leap days, including the 8-year gap over 2100', () => {
    expect(runs('0 0 29 2 *', '2026-01-01T00:00:00Z', 2)).toEqual(['2028-02-29T00:00:00Z', '2032-02-29T00:00:00Z']);
    expect(runs('0 0 29 2 *', '2096-03-01T00:00:00Z', 1)).toEqual(['2104-02-29T00:00:00Z']); // 2100 no es bisiesto
  });

  it('returns null for schedules that can never run', () => {
    expect(parse('0 0 30 2 *').next(new Date('2026-01-01T00:00:00Z'))).toBeNull();
    expect(parse('0 0 31 4,6,9,11 *').next(new Date('2026-01-01T00:00:00Z'))).toBeNull();
    expect(parse('0 0 30 2 *').nextRuns(3, new Date('2026-01-01T00:00:00Z'))).toEqual([]);
  });

  it('skips months that are too short for a fixed day', () => {
    expect(runs('0 0 31 * *', '2026-01-31T12:00:00Z', 4)).toEqual(['2026-03-31T00:00:00Z', '2026-05-31T00:00:00Z', '2026-07-31T00:00:00Z', '2026-08-31T00:00:00Z']);
  });

  it('supports seconds', () => {
    expect(runs('*/20 * * * * *', '2026-01-01T00:00:05Z', 4, { seconds: true })).toEqual(['2026-01-01T00:00:20Z', '2026-01-01T00:00:40Z', '2026-01-01T00:01:00Z', '2026-01-01T00:01:20Z']);
    expect(runs('30 15 10 * * *', '2026-01-01T10:15:30Z', 1, { seconds: true })).toEqual(['2026-01-02T10:15:30Z']);
  });

  it('accepts numbers and Dates as `from`, and rejects invalid ones', () => {
    const s = parse('0 * * * *');
    expect(s.next(Date.UTC(2026, 0, 1, 0, 30))?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(() => s.next(new Date('nope'))).toThrow(TypeError);
  });
});

describe('day-of-month vs day-of-week', () => {
  it('both restricted: OR (classic cron). Friday the 13th runs on every 13th AND every Friday', () => {
    expect(runs('0 0 13 * 5', '2026-02-01T00:00:00Z', 6)).toEqual([
      '2026-02-06T00:00:00Z', '2026-02-13T00:00:00Z', '2026-02-20T00:00:00Z', '2026-02-27T00:00:00Z', '2026-03-06T00:00:00Z', '2026-03-13T00:00:00Z',
    ]);
    // días 15 O lunes (junio 2026: lunes 1, 8, 15, 22, 29): el 15 coincide con ambos y sale una sola vez
    expect(runs('0 0 15 * 1', '2026-06-01T00:00:00Z', 4)).toEqual(['2026-06-08T00:00:00Z', '2026-06-15T00:00:00Z', '2026-06-22T00:00:00Z', '2026-06-29T00:00:00Z']);
  });

  it('one of them is "*": AND (the star matches everything); both restricted: OR', () => {
    expect(runs('0 0 * * 1', '2026-06-01T00:00:00Z', 2)).toEqual(['2026-06-08T00:00:00Z', '2026-06-15T00:00:00Z']);
    // pero con ambos restringidos es OR: días 1-7 O lunes → tras el día 1 viene el 2, no el lunes 8
    expect(runs('0 0 1-7 * 1', '2026-06-01T00:00:00Z', 3)).toEqual(['2026-06-02T00:00:00Z', '2026-06-03T00:00:00Z', '2026-06-04T00:00:00Z']);
  });

  it('"*/n" in one field counts as a wildcard (Vixie rule), so it ANDs with the other', () => {
    // días impares Y lunes
    const r = parse('0 0 */2 * 1').between(new Date('2026-06-01T00:00:00Z'), new Date('2026-07-31T00:00:00Z'));
    for (const d of r) {
      expect(d.getUTCDay()).toBe(1);
      expect(d.getUTCDate() % 2).toBe(1);
    }
    expect(r.length).toBeGreaterThan(0);
  });
});

describe('extended syntax', () => {
  it('L = last day of month (28/29/30/31)', () => {
    expect(runs('0 0 L * *', '2026-01-01T00:00:00Z', 4)).toEqual(['2026-01-31T00:00:00Z', '2026-02-28T00:00:00Z', '2026-03-31T00:00:00Z', '2026-04-30T00:00:00Z']);
    expect(runs('0 0 L 2 *', '2027-01-01T00:00:00Z', 2)).toEqual(['2027-02-28T00:00:00Z', '2028-02-29T00:00:00Z']);
  });

  it('LW = last weekday of the month', () => {
    expect(runs('0 0 LW * *', '2026-05-01T00:00:00Z', 2)).toEqual(['2026-05-29T00:00:00Z', '2026-06-30T00:00:00Z']); // 31 may = domingo
  });

  it('nW = weekday nearest day n, never leaving the month', () => {
    expect(runs('0 0 15W 6,8,11 *', '2026-01-01T00:00:00Z', 3)).toEqual(['2026-06-15T00:00:00Z', '2026-08-14T00:00:00Z', '2026-11-16T00:00:00Z']); // lun, sáb→vie, dom→lun
    expect(runs('0 0 1W 8 *', '2026-01-01T00:00:00Z', 1)).toEqual(['2026-08-03T00:00:00Z']); // 1 ago = sábado → lunes 3 (no el viernes 31 jul)
    expect(runs('0 0 31W 5 *', '2026-01-01T00:00:00Z', 1)).toEqual(['2026-05-29T00:00:00Z']); // 31 may = domingo → viernes 29 (no el lunes 1 jun)
  });

  it('n#k = k-th weekday of the month; months without a 5th occurrence are skipped', () => {
    expect(runs('0 0 * * 5#3', '2026-01-01T00:00:00Z', 3)).toEqual(['2026-01-16T00:00:00Z', '2026-02-20T00:00:00Z', '2026-03-20T00:00:00Z']);
    expect(runs('0 0 * * 1#5', '2026-01-01T00:00:00Z', 3)).toEqual(['2026-03-30T00:00:00Z', '2026-06-29T00:00:00Z', '2026-08-31T00:00:00Z']);
  });

  it('nL = last such weekday of the month', () => {
    expect(runs('0 0 * * 5L', '2026-01-01T00:00:00Z', 3)).toEqual(['2026-01-30T00:00:00Z', '2026-02-27T00:00:00Z', '2026-03-27T00:00:00Z']);
    expect(runs('0 0 * * SUNL', '2026-01-01T00:00:00Z', 1)).toEqual(['2026-01-25T00:00:00Z']);
  });
});

describe('matches()', () => {
  it('agrees with the definition for UTC schedules', () => {
    const s = parse('30 9 * * MON-FRI');
    expect(s.matches(new Date('2026-03-09T09:30:00Z'))).toBe(true); // lunes
    expect(s.matches(new Date('2026-03-09T09:30:42Z'))).toBe(true); // los segundos se ignoran sin `seconds`
    expect(s.matches(new Date('2026-03-09T09:31:00Z'))).toBe(false);
    expect(s.matches(new Date('2026-03-08T09:30:00Z'))).toBe(false); // domingo
  });

  it('every result of nextRuns() matches, and the instants in between do not', () => {
    const s = parse('7,37 */5 * * *');
    const rs = s.nextRuns(10, new Date('2026-03-01T00:00:00Z'));
    for (const r of rs) expect(s.matches(r)).toBe(true);
    for (let i = 1; i < rs.length; i++) expect(s.matches(new Date((+rs[i - 1]! + +rs[i]!) / 2 + 30_000))).toBe(false);
  });
});

describe('between() and iterate()', () => {
  it('lists runs in (from, to] and honours the limit', () => {
    const s = parse('0 * * * *');
    const day = s.between(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    expect(day).toHaveLength(24);
    expect(day[0]!.toISOString()).toBe('2026-03-01T01:00:00.000Z');
    expect(day.at(-1)!.toISOString()).toBe('2026-03-02T00:00:00.000Z'); // `to` es inclusivo
    expect(s.between(new Date('2026-03-01T00:00:00Z'), new Date('2027-03-01T00:00:00Z'), { limit: 5 })).toHaveLength(5);
    expect(s.between(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))).toEqual([]);
  });

  it('iterate() is lazy and can be consumed partially', () => {
    const it = parse('* * * * *').iterate(new Date('2026-01-01T00:00:00Z'));
    expect(it.next().value!.toISOString()).toBe('2026-01-01T00:01:00.000Z');
    expect(it.next().value!.toISOString()).toBe('2026-01-01T00:02:00.000Z');
  });
});

describe('Schedule object', () => {
  it('exposes the normalised expression and the zone', () => {
    const s = parse('@daily', { tz: 'Europe/Madrid' });
    expect(s.expression).toBe('0 0 * * *');
    expect(String(s)).toBe('0 0 * * *');
    expect(s.tz).toBe('Europe/Madrid');
    expect(parse('* * * * *').tz).toBe('UTC');
  });
  it('rejects unknown time zones at construction time', () => {
    expect(() => parse('* * * * *', { tz: 'Mars/Phobos' })).toThrow(/Unknown time zone/);
  });
});

describe('time zones without DST', () => {
  it('applies a fixed offset, including half-hour zones', () => {
    expect(runs('0 9 * * *', '2026-01-01T00:00:00Z', 2, { tz: 'Asia/Kolkata' })).toEqual(['2026-01-01T03:30:00Z', '2026-01-02T03:30:00Z']); // +05:30
    expect(runs('0 9 * * *', '2025-12-31T23:00:00Z', 1, { tz: 'Asia/Tokyo' })).toEqual(['2026-01-01T00:00:00Z']); // +09:00
    expect(runs('0 0 * * *', '2026-01-01T00:00:00Z', 1, { tz: 'Asia/Kathmandu' })).toEqual(['2026-01-01T18:15:00Z']); // +05:45
  });
  it('the local day changes with the zone: "weekdays" differ between Tokyo and Los Angeles', () => {
    const tokyo = parse('0 0 * * 1', { tz: 'Asia/Tokyo' }).next(new Date('2026-03-01T00:00:00Z'))!;
    const la = parse('0 0 * * 1', { tz: 'America/Los_Angeles' }).next(new Date('2026-03-01T00:00:00Z'))!;
    expect(tokyo.toISOString()).toBe('2026-03-01T15:00:00.000Z'); // lunes 2 mar 00:00 JST
    expect(la.toISOString()).toBe('2026-03-02T08:00:00.000Z'); // lunes 2 mar 00:00 PST
  });
});

describe('daylight saving time (America/New_York, 2026: gap Mar 8, overlap Nov 1)', () => {
  const NY = { tz: 'America/New_York' };

  describe('spring forward: 02:00 → 03:00 (02:xx does not exist)', () => {
    it('shift (default): a fixed time inside the gap runs at the first valid instant', () => {
      expect(runs('30 2 * * *', '2026-03-07T12:00:00Z', 3, NY)).toEqual([
        '2026-03-08T07:00:00Z', // 03:00 EDT, en vez del inexistente 02:30
        '2026-03-09T06:30:00Z', // 02:30 EDT, ya normal
        '2026-03-10T06:30:00Z',
      ]);
    });
    it('skip: that day does not run', () => {
      expect(runs('30 2 * * *', '2026-03-07T12:00:00Z', 2, { ...NY, dstGap: 'skip' })).toEqual(['2026-03-09T06:30:00Z', '2026-03-10T06:30:00Z']);
    });
    it('several skipped times collapse into ONE run, not several', () => {
      expect(runs('15,45 2 * * *', '2026-03-07T12:00:00Z', 4, NY)).toEqual(['2026-03-08T07:00:00Z', '2026-03-09T06:15:00Z', '2026-03-09T06:45:00Z', '2026-03-10T06:15:00Z']);
    });
    it('times outside the gap are untouched', () => {
      expect(runs('0 3 * * *', '2026-03-07T12:00:00Z', 2, NY)).toEqual(['2026-03-08T07:00:00Z', '2026-03-09T07:00:00Z']);
      expect(runs('59 1 * * *', '2026-03-07T12:00:00Z', 2, NY)).toEqual(['2026-03-08T06:59:00Z', '2026-03-09T05:59:00Z']);
    });
    it('wildcard schedules simply have no run during the gap', () => {
      const r = parse('*/30 * * * *', NY).between(new Date('2026-03-08T06:00:00Z'), new Date('2026-03-08T08:00:00Z'));
      expect(iso(r)).toEqual(['2026-03-08T06:30:00Z', '2026-03-08T07:00:00Z', '2026-03-08T07:30:00Z', '2026-03-08T08:00:00Z']); // sin huecos ni duplicados
    });
    it('matches() agrees with next() about the shifted run', () => {
      const shift = parse('30 2 * * *', NY);
      expect(shift.matches(new Date('2026-03-08T07:00:00Z'))).toBe(true);
      expect(shift.matches(new Date('2026-03-08T06:59:00Z'))).toBe(false);
      expect(shift.matches(new Date('2026-03-08T07:01:00Z'))).toBe(false);
      expect(parse('30 2 * * *', { ...NY, dstGap: 'skip' }).matches(new Date('2026-03-08T07:00:00Z'))).toBe(false);
    });
  });

  describe('fall back: 02:00 → 01:00 (01:xx happens twice)', () => {
    it('a FIXED hour runs once (the first time)', () => {
      expect(runs('30 1 * * *', '2026-10-31T12:00:00Z', 3, NY)).toEqual(['2026-11-01T05:30:00Z', '2026-11-02T06:30:00Z', '2026-11-03T06:30:00Z']); // 01:30 EDT una vez
    });
    it('a wildcard hour runs at EVERY real instant (no gap, no repetition, no skip)', () => {
      const r = parse('0 * * * *', NY).between(new Date('2026-11-01T03:00:00Z'), new Date('2026-11-01T09:00:00Z'));
      expect(iso(r)).toEqual(['2026-11-01T04:00:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', '2026-11-01T08:00:00Z', '2026-11-01T09:00:00Z']);
    });
    it('every-30-minutes keeps a constant cadence through the repeated hour', () => {
      const r = parse('*/30 * * * *', NY).between(new Date('2026-11-01T03:00:00Z'), new Date('2026-11-01T09:00:00Z'));
      for (let i = 1; i < r.length; i++) expect(+r[i]! - +r[i - 1]!).toBe(30 * 60_000);
      expect(r).toHaveLength(12);
    });
    it('matches() runs a fixed hour only on its first occurrence, a wildcard hour on both', () => {
      const fixed = parse('30 1 * * *', NY);
      expect(fixed.matches(new Date('2026-11-01T05:30:00Z'))).toBe(true); // 01:30 EDT
      expect(fixed.matches(new Date('2026-11-01T06:30:00Z'))).toBe(false); // 01:30 EST (segunda vez)
      const wild = parse('30 * * * *', NY);
      expect(wild.matches(new Date('2026-11-01T05:30:00Z'))).toBe(true);
      expect(wild.matches(new Date('2026-11-01T06:30:00Z'))).toBe(true);
    });
  });

  it('works for other zones and unusual shifts (London, Sydney, Lord Howe with a 30-minute shift)', () => {
    expect(runs('30 1 * * *', '2026-03-28T12:00:00Z', 2, { tz: 'Europe/London' })).toEqual(['2026-03-29T01:00:00Z', '2026-03-30T00:30:00Z']); // 01:30 no existe (01:00→02:00): corre a las 02:00 BST = 01:00Z
    // Lord Howe: el 4 oct 02:00 salta a 02:30 (¡30 minutos!). 02:15 no existe → corre a las 02:30 local (= 03 oct 15:30Z)
    expect(runs('15 2 * * *', '2026-10-03T00:00:00Z', 2, { tz: 'Australia/Lord_Howe' })).toEqual(['2026-10-03T15:30:00Z', '2026-10-04T15:15:00Z']);
  });
});
