import { daysInMonth } from './calendar.js';
import { parse, type Schedule } from './schedule.js';
import { observesDst } from './tz.js';
import type { ParseOptions } from './types.js';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintWarning {
  code: 'never-runs' | 'every-minute' | 'high-frequency' | 'dom-dow-or' | 'non-portable' | 'dst-ambiguous-hour' | 'skips-short-months';
  severity: LintSeverity;
  message: string;
}

/**
 * Detecta expresiones válidas pero probablemente equivocadas o peligrosas.
 * Cada aviso explica el riesgo concreto, no solo "mala práctica".
 */
export function lint(expressionOrSchedule: string | Schedule, opts: ParseOptions = {}): LintWarning[] {
  const s = typeof expressionOrSchedule === 'string' ? parse(expressionOrSchedule, opts) : expressionOrSchedule;
  const p = s.parsed;
  const out: LintWarning[] = [];

  const now = Date.now();
  if (s.next(now) === null) {
    out.push({ code: 'never-runs', severity: 'error', message: 'This expression never runs (no matching date in the next 9 years), e.g. February 30th or April 31st.' });
    return out; // el resto de comprobaciones no tiene sentido
  }

  const minutesPerHour = p.minutes.values.length;
  const hoursPerDay = p.hours.values.length;
  const secondsPerMinute = p.hasSeconds ? p.seconds.values.length : 1;
  const perDay = secondsPerMinute * minutesPerHour * hoursPerDay;

  if (p.hasSeconds && secondsPerMinute >= 30) {
    out.push({ code: 'high-frequency', severity: 'warning', message: `Runs ${secondsPerMinute} times per minute. Make sure the job is idempotent and finishes faster than the interval.` });
  } else if (minutesPerHour === 60 && hoursPerDay === 24 && secondsPerMinute === 1) {
    out.push({ code: 'every-minute', severity: 'info', message: 'Runs every minute (1 440 times a day). Intentional?' });
  } else if (perDay >= 720) {
    out.push({ code: 'high-frequency', severity: 'info', message: `Runs about ${perDay} times a day.` });
  }

  if (!p.dom.star && !p.dow.star) {
    out.push({
      code: 'dom-dow-or',
      severity: 'warning',
      message: 'Both day-of-month and day-of-week are set: cron runs when EITHER matches (not both). "0 0 13 * 5" runs every 13th AND every Friday. For "Friday the 13th" run daily and check the date in the job.',
    });
  }

  if (p.usesExtended) {
    out.push({ code: 'non-portable', severity: 'info', message: 'Uses L, W or # (Quartz-style extensions). Classic cron, crontab(5) and most cloud schedulers do not support them.' });
  }

  if (!p.dom.star && p.dom.values.length > 0 && !p.dom.last && p.dom.values.every((d) => d >= 29) && p.months.values.some((m) => daysInMonth(2025, m) < Math.min(...p.dom.values))) {
    out.push({ code: 'skips-short-months', severity: 'warning', message: `Only days ${p.dom.values.join(', ')} are listed, so months that are too short are skipped. Use "L" (last day of month) to run every month.` });
  }

  if (s.tz !== 'UTC' && observesDst(s.tz) && !p.hours.star && p.hours.values.some((h) => h >= 1 && h <= 3)) {
    out.push({
      code: 'dst-ambiguous-hour',
      severity: 'warning',
      message: `Time zone ${s.tz} changes its clock between 01:00 and 03:00 on some nights: that run may be shifted (spring) or happen once instead of twice (autumn). Consider scheduling outside 01:00-03:59 or use UTC.`,
    });
  }
  return out;
}
