/** Contadores en proceso, expuestos en formato Prometheus. */
export class Metrics {
  private counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = name + (Object.keys(labels).length ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '');
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  get(name: string, labels: Record<string, string> = {}): number {
    const key = name + (Object.keys(labels).length ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '');
    return this.counters.get(key) ?? 0;
  }

  render(extra: Array<{ name: string; help: string; type: 'gauge' | 'counter'; samples: Array<{ labels: Record<string, string>; value: number }> }> = []): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const [key, v] of [...this.counters.entries()].sort()) {
      const base = key.split('{')[0]!;
      if (!seen.has(base)) {
        lines.push(`# TYPE ${base} counter`);
        seen.add(base);
      }
      lines.push(`${key} ${v}`);
    }
    for (const m of extra) {
      lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`);
      for (const s of m.samples) {
        const l = Object.entries(s.labels).map(([k, v]) => `${k}="${v}"`).join(',');
        lines.push(`${m.name}${l ? `{${l}}` : ''} ${s.value}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}
