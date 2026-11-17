// Fichero que consume la API PÚBLICA tal y como la vería un usuario: si los tipos publicados están mal, no compila.
import { parse, validate, lint, explain, CronParseError, type Schedule, type LintWarning, type ValidationResult } from '../../dist/index.js';

const s: Schedule = parse('*/15 9-17 * * MON-FRI', { tz: 'America/New_York', dstGap: 'skip' });
const next: Date | null = s.next(new Date());
const runs: Date[] = s.nextRuns(5);
const between: Date[] = s.between(new Date(), Date.now() + 86_400_000, { limit: 10 });
const text: string = s.explain({ locale: 'es', hour12: true });
const v: ValidationResult = validate('* * * * *');
if (!v.valid) console.error(v.error.formatted, v.error.hint);
const w: LintWarning[] = lint('0 0 13 * 5');
const code: string = w[0]?.code ?? '';
try {
  parse('nope');
} catch (e) {
  if (e instanceof CronParseError) console.log(e.start, e.end, e.field, e.hint, e.format());
}
// @ts-expect-error: la opción dstGap solo admite 'shift' | 'skip'
parse('* * * * *', { dstGap: 'later' });
console.log(next, runs, between, text, code, explain('@daily'));
