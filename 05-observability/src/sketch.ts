/**
 * Sketch de cuantiles tipo DDSketch: histograma con cubetas logarítmicas que garantiza un ERROR RELATIVO
 * acotado (por defecto 1 %) en cualquier percentil, y que es MERGEABLE (sumar dos sketches = el sketch de la unión).
 *
 * Por qué no guardar el p99 de cada minuto: los percentiles NO se pueden promediar ni combinar
 * (el p99 de dos series no es la media de sus p99). Guardando sketches, un rollup de 1 h o una
 * agregación entre 50 instancias sigue dando el percentil correcto.
 *
 * Valores: no negativos (latencias, tamaños). Lo <= 0 (o ~0) va a una cubeta "cero".
 */
export class Sketch {
  private readonly gamma: number;
  private readonly lnGamma: number;
  private zero = 0;
  private readonly buckets = new Map<number, number>();
  count = 0;

  constructor(readonly alpha = 0.01) {
    this.gamma = (1 + alpha) / (1 - alpha);
    this.lnGamma = Math.log(this.gamma);
  }

  private static readonly MIN_VALUE = 1e-9;

  add(value: number, n = 1): void {
    if (!(value > Sketch.MIN_VALUE)) this.zero += n;
    else {
      const idx = Math.ceil(Math.log(value) / this.lnGamma);
      this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + n);
    }
    this.count += n;
  }

  merge(other: Sketch): this {
    if (other.alpha !== this.alpha) throw new Error('Cannot merge sketches with different accuracy');
    this.zero += other.zero;
    for (const [i, c] of other.buckets) this.buckets.set(i, (this.buckets.get(i) ?? 0) + c);
    this.count += other.count;
    return this;
  }

  /** Cuantil q en [0,1]. Error relativo <= alpha respecto al valor real. */
  quantile(q: number): number | null {
    if (this.count === 0) return null;
    const rank = Math.min(Math.max(q, 0), 1) * (this.count - 1);
    if (rank < this.zero) return 0;
    let seen = this.zero;
    for (const idx of [...this.buckets.keys()].sort((a, b) => a - b)) {
      seen += this.buckets.get(idx)!;
      if (seen > rank) return (2 * Math.pow(this.gamma, idx)) / (this.gamma + 1);
    }
    return null;
  }

  get bucketCount(): number {
    return this.buckets.size + (this.zero ? 1 : 0);
  }

  /** Formato compacto: [alpha, zero, idx1, count1, idx2, count2, ...] */
  serialize(): string {
    const flat: number[] = [this.alpha, this.zero];
    for (const [i, c] of [...this.buckets].sort((a, b) => a[0] - b[0])) flat.push(i, c);
    return JSON.stringify(flat);
  }

  static deserialize(s: string): Sketch {
    const [alpha, zero, ...rest] = JSON.parse(s) as number[];
    const sk = new Sketch(alpha);
    sk.zero = zero!;
    sk.count = zero!;
    for (let i = 0; i < rest.length; i += 2) {
      sk.buckets.set(rest[i]!, rest[i + 1]!);
      sk.count += rest[i + 1]!;
    }
    return sk;
  }
}
