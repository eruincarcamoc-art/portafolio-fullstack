export type FieldName = 'second' | 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week';

/**
 * Error de sintaxis con ubicación exacta. `start`/`end` son índices (end exclusivo) en la expresión
 * ORIGINAL, para poder señalar el fragmento culpable; `hint` propone una corrección cuando es posible.
 */
export class CronParseError extends Error {
  readonly name = 'CronParseError';
  constructor(
    message: string,
    readonly input: string,
    readonly start: number,
    readonly end: number,
    readonly field?: FieldName,
    readonly hint?: string,
  ) {
    super(message);
  }

  /** Texto de varias líneas con la expresión y una marca bajo el fragmento erróneo. */
  format(): string {
    const caret = ' '.repeat(this.start) + '^'.repeat(Math.max(1, this.end - this.start));
    const where = this.field ? `${this.field}: ` : '';
    return [`${where}${this.message}`, `  ${this.input}`, `  ${caret}`, ...(this.hint ? [`  hint: ${this.hint}`] : [])].join('\n');
  }
}
