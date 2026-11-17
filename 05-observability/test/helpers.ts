import { loadConfig, type Config } from '../src/config.js';
import { Ingestor } from '../src/ingest.js';
import { SeriesRegistry } from '../src/series.js';
import { Store } from '../src/store.js';

export const T0 = Date.parse('2026-03-01T12:00:00.000Z');

/** Reloj controlado: los tests avanzan el tiempo sin dormir. */
export function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}

export function makeSystem(env: Record<string, string> = {}, startAt = T0) {
  const cfg: Config = loadConfig({ NODE_ENV: 'test', DB_PATH: ':memory:', ...env } as any);
  const c = clock(startAt);
  const store = new Store(':memory:', cfg);
  const registry = new SeriesRegistry(cfg.MAX_SERIES_PER_METRIC, cfg.MAX_SERIES_TOTAL);
  registry.load(store.loadSeries());
  const ingestor = new Ingestor(store, registry, cfg, c.now);
  return { cfg, clock: c, store, registry, ingestor };
}

/** PRNG determinista. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal estándar (Box-Muller) a partir de un PRNG uniforme. */
export const normal = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

export const exactQuantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
};
