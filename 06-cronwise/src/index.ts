import { CronParseError } from './errors.js';
import { parse as parseSchedule, Schedule } from './schedule.js';
import type { ParseOptions } from './types.js';

export { Schedule, parse } from './schedule.js';
export type { IterateOptions } from './schedule.js';
export { CronParseError } from './errors.js';
export type { FieldName } from './errors.js';
export { TimezoneError } from './tz.js';
export { MACROS } from './parse.js';
export type { ParseOptions, ParsedCron, FieldSpec, DomSpec, DowSpec } from './types.js';
export type { ExplainOptions, Locale } from './explain.js';
export { lint } from './lint.js';
export type { LintWarning, LintSeverity } from './lint.js';

export type ValidationResult =
  | { valid: true; normalized: string }
  | { valid: false; error: { message: string; field?: string; start: number; end: number; hint?: string; formatted: string } };

/**
 * Valida una expresión SIN lanzar excepciones: pensado para formularios y APIs.
 * (Los errores de zona horaria inválida también se devuelven como resultado.)
 */
export function validate(expression: string, opts: ParseOptions = {}): ValidationResult {
  try {
    const s: Schedule = parseSchedule(expression, opts);
    return { valid: true, normalized: s.expression };
  } catch (e) {
    if (e instanceof CronParseError) {
      return { valid: false, error: { message: e.message, field: e.field, start: e.start, end: e.end, hint: e.hint, formatted: e.format() } };
    }
    return { valid: false, error: { message: (e as Error).message, start: 0, end: 0, formatted: (e as Error).message } };
  }
}

/** Atajo: lenguaje natural de una expresión. */
export function explain(expression: string, opts: ParseOptions & { locale?: 'en' | 'es'; hour12?: boolean } = {}): string {
  return parseSchedule(expression, opts).explain({ locale: opts.locale, hour12: opts.hour12 });
}
