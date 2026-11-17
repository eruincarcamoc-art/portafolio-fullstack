export type MetricType = 'counter' | 'gauge' | 'timer';
export const METRIC_TYPES: readonly MetricType[] = ['counter', 'gauge', 'timer'];

export type Labels = Record<string, string>;

export const LIMITS = {
  maxLabels: 20,
  maxLabelValueLen: 128,
  maxNameLen: 128,
} as const;

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
const LABEL_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

export class ValidationError extends Error {}

export function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > LIMITS.maxNameLen || !NAME_RE.test(name)) {
    throw new ValidationError('invalid metric name');
  }
  return name;
}

export function validateLabels(labels: unknown): Labels {
  if (labels === undefined || labels === null) return {};
  if (typeof labels !== 'object' || Array.isArray(labels)) throw new ValidationError('labels must be an object');
  const entries = Object.entries(labels as Record<string, unknown>);
  if (entries.length > LIMITS.maxLabels) throw new ValidationError(`too many labels (max ${LIMITS.maxLabels})`);
  const out: Labels = {};
  for (const [k, v] of entries) {
    if (!LABEL_KEY_RE.test(k)) throw new ValidationError(`invalid label name "${k.slice(0, 30)}"`);
    if (typeof v !== 'string' || v.length > LIMITS.maxLabelValueLen) throw new ValidationError(`invalid value for label "${k}"`);
    out[k] = v;
  }
  return out;
}

/** Clave canónica de la serie: independiente del orden de las etiquetas. */
export function seriesKey(name: string, labels: Labels): string {
  const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(',')}}`;
}

export interface Series {
  id: number;
  name: string;
  type: MetricType;
  labels: Labels;
  key: string;
}

export class CardinalityError extends Error {
  constructor(readonly scope: 'metric' | 'global') {
    super(`series limit reached (${scope})`);
  }
}

export class TypeConflictError extends Error {}

/**
 * Registro en memoria de todas las series conocidas. La CARDINALIDAD (nº de combinaciones de etiquetas)
 * es lo que hace explotar a un sistema de métricas: una etiqueta `user_id` o `request_id` crea una serie por
 * valor. Aquí hay un tope por métrica y otro global; al superarlos se rechazan las series NUEVAS (las existentes
 * siguen funcionando) y se contabiliza, en vez de tumbar el almacén.
 */
export class SeriesRegistry {
  private byKey = new Map<string, Series>();
  private byId = new Map<number, Series>();
  private perMetric = new Map<string, number>();

  constructor(
    private readonly maxPerMetric: number,
    private readonly maxTotal: number,
  ) {}

  load(all: Series[]): void {
    for (const s of all) this.add(s);
  }

  private add(s: Series): void {
    this.byKey.set(s.key, s);
    this.byId.set(s.id, s);
    this.perMetric.set(s.name, (this.perMetric.get(s.name) ?? 0) + 1);
  }

  get size(): number {
    return this.byKey.size;
  }

  get(key: string): Series | undefined {
    return this.byKey.get(key);
  }

  byIdOf(id: number): Series | undefined {
    return this.byId.get(id);
  }

  /** Comprueba límites y tipo sin crear nada. Devuelve la serie existente o null si hay que crearla. */
  resolve(name: string, type: MetricType, key: string): Series | null {
    const existing = this.byKey.get(key);
    if (existing) {
      if (existing.type !== type) throw new TypeConflictError(`metric "${name}" already exists as ${existing.type}`);
      return existing;
    }
    // el tipo es por métrica, no por serie
    for (const s of this.byId.values()) {
      if (s.name === name) {
        if (s.type !== type) throw new TypeConflictError(`metric "${name}" already exists as ${s.type}`);
        break;
      }
    }
    if (this.byKey.size >= this.maxTotal) throw new CardinalityError('global');
    if ((this.perMetric.get(name) ?? 0) >= this.maxPerMetric) throw new CardinalityError('metric');
    return null;
  }

  register(s: Series): void {
    this.add(s);
  }

  forget(id: number): void {
    const s = this.byId.get(id);
    if (!s) return;
    this.byId.delete(id);
    this.byKey.delete(s.key);
    this.perMetric.set(s.name, Math.max(0, (this.perMetric.get(s.name) ?? 1) - 1));
  }

  metrics(): Array<{ name: string; type: MetricType; series: number }> {
    const out = new Map<string, { name: string; type: MetricType; series: number }>();
    for (const s of this.byId.values()) {
      const m = out.get(s.name) ?? { name: s.name, type: s.type, series: 0 };
      m.series++;
      out.set(s.name, m);
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  seriesOf(name: string): Series[] {
    return [...this.byId.values()].filter((s) => s.name === name);
  }

  all(): Series[] {
    return [...this.byId.values()];
  }
}
