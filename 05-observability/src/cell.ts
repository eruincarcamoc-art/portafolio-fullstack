import { Sketch } from './sketch.js';

/**
 * Resumen estadístico de un trozo de serie (una cubeta de tiempo). Es el átomo de TODO el sistema:
 * la ingesta lo construye, el almacén lo guarda, los rollups y las consultas lo FUSIONAN.
 * `merge` es asociativo y conmutativo (un monoide), así que se puede agregar en cualquier orden y por tramos.
 */
export interface Cell {
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
  lastTs: number;
  /** Solo en métricas tipo timer: permite percentiles correctos tras agregar. */
  sketch: Sketch | null;
}

export function newCell(withSketch: boolean): Cell {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity, last: 0, lastTs: -1, sketch: withSketch ? new Sketch() : null };
}

export function addValue(c: Cell, value: number, ts: number): void {
  c.count++;
  c.sum += value;
  if (value < c.min) c.min = value;
  if (value > c.max) c.max = value;
  if (ts >= c.lastTs) {
    c.last = value;
    c.lastTs = ts;
  }
  c.sketch?.add(value);
}

/** Fusiona `b` dentro de `a` (muta `a`). */
export function mergeCell(a: Cell, b: Cell): Cell {
  a.count += b.count;
  a.sum += b.sum;
  if (b.min < a.min) a.min = b.min;
  if (b.max > a.max) a.max = b.max;
  if (b.lastTs >= a.lastTs) {
    a.last = b.last;
    a.lastTs = b.lastTs;
  }
  if (b.sketch) {
    if (!a.sketch) a.sketch = new Sketch(b.sketch.alpha);
    a.sketch.merge(b.sketch);
  }
  return a;
}

export function cloneCell(c: Cell): Cell {
  return mergeCell(newCell(false), c);
}

export type Agg = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'last' | 'rate' | `p${number}`;

export const isPercentile = (agg: string): boolean => /^p\d{1,2}(\.\d+)?$/.test(agg) || agg === 'p100';

export function parseAgg(s: string): Agg | null {
  if (['count', 'sum', 'avg', 'min', 'max', 'last', 'rate'].includes(s)) return s as Agg;
  if (isPercentile(s)) return s as Agg;
  return null;
}

/** Calcula el valor de una agregación sobre una celda. `stepSec` solo se usa para `rate`. */
export function computeAgg(c: Cell, agg: Agg, stepSec: number): number | null {
  if (c.count === 0) return null;
  switch (agg) {
    case 'count': return c.count;
    case 'sum': return c.sum;
    case 'avg': return c.sum / c.count;
    case 'min': return c.min;
    case 'max': return c.max;
    case 'last': return c.last;
    case 'rate': return c.sum / stepSec;
    default: {
      const q = c.sketch?.quantile(Number(agg.slice(1)) / 100);
      if (q === null || q === undefined) return null;
      return Math.min(Math.max(q, c.min), c.max); // el sketch nunca puede salirse del rango observado
    }
  }
}
