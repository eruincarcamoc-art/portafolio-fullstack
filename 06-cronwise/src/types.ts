export interface FieldSpec {
  /** Valores permitidos, ordenados y sin repetir. */
  values: number[];
  /** El campo empieza por `*` o `?`: "cualquiera". Importa para la regla día-del-mes / día-de-la-semana. */
  star: boolean;
  /** Texto original del campo (con los nombres y macros ya expandidos a la forma de 5/6 campos). */
  raw: string;
}

export interface DomSpec extends FieldSpec {
  /** `L`: último día del mes. */
  last: boolean;
  /** `LW`: último día laborable. */
  lastWeekday: boolean;
  /** `nW`: día laborable más cercano al día n. */
  nearest: number[];
}

export interface DowSpec extends FieldSpec {
  /** `n#k`: k-ésimo día de la semana `n` del mes (p. ej. 5#3 = tercer viernes). */
  nth: Array<{ dow: number; n: number }>;
  /** `nL`: último día de la semana `n` del mes. */
  last: number[];
}

export interface ParsedCron {
  /** Siempre presente; con `seconds: false` vale [0]. */
  seconds: FieldSpec;
  minutes: FieldSpec;
  hours: FieldSpec;
  dom: DomSpec;
  months: FieldSpec;
  dow: DowSpec;
  /** Expresión normalizada (macros expandidas). */
  expression: string;
  /** Usa `L`, `W` o `#` (no portable a cron clásico). */
  usesExtended: boolean;
  hasSeconds: boolean;
}

export interface ParseOptions {
  /** Zona horaria IANA. Por defecto 'UTC'. */
  tz?: string;
  /** La expresión tiene 6 campos con los segundos al principio. */
  seconds?: boolean;
  /**
   * Qué hacer con una hora que no existe por el cambio a horario de verano (p. ej. 02:30 cuando 02:00 salta a 03:00):
   *  - 'shift' (por defecto): se ejecuta en el primer instante válido tras el hueco (como Vixie cron / cronie).
   *  - 'skip': ese día no se ejecuta.
   */
  dstGap?: 'shift' | 'skip';
}
