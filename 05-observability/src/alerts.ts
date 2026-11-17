import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { parseAgg } from './cell.js';
import { instantQuery, QueryError } from './query.js';
import type { Labels, SeriesRegistry } from './series.js';
import type { Store } from './store.js';

export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  metric: z.string().min(1).max(128),
  agg: z.string().refine((a) => parseAgg(a) !== null, 'unknown aggregation'),
  windowSec: z.number().int().min(10).max(86_400),
  op: z.enum(['>', '>=', '<', '<=', '==']),
  threshold: z.number().finite(),
  /** La condición debe mantenerse este tiempo antes de disparar (evita alertas por picos de 1 muestra). */
  forSec: z.number().int().min(0).max(86_400).default(0),
  groupBy: z.array(z.string().max(64)).max(5).optional(),
  filters: z.record(z.string(), z.string().max(256)).optional(),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  /** Qué hacer si no llegan datos: 'alert' convierte el silencio en alerta (dead man's switch). */
  noData: z.enum(['ok', 'alert', 'keep']).default('ok'),
  webhook: z.string().url().max(500).optional(),
  /** Si se define, se re-notifica cada N segundos mientras siga disparada. */
  repeatSec: z.number().int().min(60).max(604_800).optional(),
});
export type RuleSpec = z.infer<typeof ruleSchema>;
export interface Rule extends RuleSpec {
  id: string;
}

export type AlertState = 'pending' | 'firing';

export interface AlertInstance {
  ruleId: string;
  groupKey: string;
  labels: Labels;
  state: AlertState;
  since: number;
  value: number | null;
  lastNotified: number | null;
}

export interface AlertEvent {
  id?: number;
  ts: number;
  ruleId: string;
  ruleName: string;
  groupKey: string;
  labels: Labels;
  from: 'ok' | AlertState;
  to: 'ok' | AlertState;
  value: number | null;
  delivery: 'none' | 'delivered' | 'failed';
}

export interface Notification {
  rule: Rule;
  state: 'firing' | 'resolved' | 'repeat';
  labels: Labels;
  value: number | null;
  at: number;
}

export interface Notifier {
  send(n: Notification): Promise<'delivered' | 'failed' | 'none'>;
}

const compare = (v: number, op: RuleSpec['op'], th: number): boolean =>
  op === '>' ? v > th : op === '>=' ? v >= th : op === '<' ? v < th : op === '<=' ? v <= th : v === th;

/**
 * Motor de alertas con máquina de estados por (regla, grupo):
 *
 *     ok ──cond──▶ pending ──cond durante `forSec`──▶ firing ──!cond──▶ ok (resolved)
 *                     └──!cond──▶ ok (sin notificar)
 *
 *  - `pending` filtra picos: una muestra mala no despierta a nadie.
 *  - Se notifica SOLO en las transiciones (firing, resolved) y, opcionalmente, cada `repeatSec`: sin tormenta de avisos.
 *  - Cada grupo (p. ej. cada servicio) tiene su propio estado.
 *  - El estado se persiste: tras un reinicio no se pierden las alertas que ya estaban disparadas ni se re-notifican.
 */
export class AlertEngine {
  private rules = new Map<string, Rule>();
  private states = new Map<string, AlertInstance>();

  constructor(
    private readonly store: Store,
    private readonly registry: SeriesRegistry,
    private readonly notifier: Notifier,
    private readonly now: () => number = Date.now,
  ) {
    for (const r of store.db.prepare(`SELECT id, spec FROM alert_rules`).all() as any[]) {
      this.rules.set(r.id, { id: r.id, ...(JSON.parse(r.spec) as RuleSpec) });
    }
    for (const s of store.db.prepare(`SELECT * FROM alert_state`).all() as any[]) {
      this.states.set(`${s.rule_id}|${s.group_key}`, {
        ruleId: s.rule_id, groupKey: s.group_key, labels: JSON.parse(s.labels), state: s.state, since: s.since, value: s.value, lastNotified: s.last_notified,
      });
    }
  }

  // ------------------------------------------------------------------ CRUD
  addRule(input: unknown): Rule {
    const spec = ruleSchema.parse(input);
    const rule: Rule = { id: randomBytes(4).toString('hex'), ...spec };
    this.store.db.prepare(`INSERT INTO alert_rules(id, spec, created_at) VALUES (?,?,?)`).run(rule.id, JSON.stringify(spec), this.now());
    this.rules.set(rule.id, rule);
    return rule;
  }

  deleteRule(id: string): boolean {
    if (!this.rules.delete(id)) return false;
    this.store.db.prepare(`DELETE FROM alert_rules WHERE id=?`).run(id);
    this.store.db.prepare(`DELETE FROM alert_state WHERE rule_id=?`).run(id);
    for (const k of [...this.states.keys()]) if (k.startsWith(`${id}|`)) this.states.delete(k);
    return true;
  }

  listRules(): Rule[] {
    return [...this.rules.values()];
  }

  active(): Array<AlertInstance & { ruleName: string; severity: string }> {
    return [...this.states.values()].map((s) => ({ ...s, ruleName: this.rules.get(s.ruleId)?.name ?? '?', severity: this.rules.get(s.ruleId)?.severity ?? 'warning' }));
  }

  events(limit = 100): AlertEvent[] {
    return (this.store.db.prepare(`SELECT * FROM alert_events ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map((e) => ({
      id: e.id, ts: e.ts, ruleId: e.rule_id, ruleName: e.rule_name, groupKey: e.group_key, labels: JSON.parse(e.labels),
      from: e.from_state, to: e.to_state, value: e.value, delivery: e.delivery,
    }));
  }

  // ------------------------------------------------------------------ evaluación
  async evaluate(): Promise<void> {
    const t = this.now();
    const jobs: Array<Promise<void>> = [];
    for (const rule of this.rules.values()) {
      let results: Map<string, { labels: Labels; value: number }>;
      try {
        results = instantQuery(this.store, this.registry, rule, t);
      } catch (e) {
        if (e instanceof QueryError) continue; // regla mal formada contra la métrica actual: se ignora este ciclo
        throw e;
      }

      const seen = new Set<string>();
      for (const [groupKey, { labels, value }] of results) {
        seen.add(groupKey);
        jobs.push(this.step(rule, groupKey, labels, compare(value, rule.op, rule.threshold), value, t));
      }

      // Grupos sin datos en esta ventana.
      const known = [...this.states.values()].filter((s) => s.ruleId === rule.id && !seen.has(s.groupKey));
      if (rule.noData === 'alert') {
        if (known.length === 0 && results.size === 0 && !(rule.groupBy?.length)) {
          jobs.push(this.step(rule, '{}', {}, true, null, t)); // regla global sin ningún dato: el silencio ES la alerta
        }
        for (const s of known) jobs.push(this.step(rule, s.groupKey, s.labels, true, null, t));
      } else if (rule.noData === 'ok') {
        for (const s of known) jobs.push(this.step(rule, s.groupKey, s.labels, false, null, t));
      } // 'keep': no se toca
    }
    await Promise.all(jobs);
  }

  private async step(rule: Rule, groupKey: string, labels: Labels, cond: boolean, value: number | null, t: number): Promise<void> {
    const key = `${rule.id}|${groupKey}`;
    const cur = this.states.get(key);

    if (!cur) {
      if (!cond) return;
      const inst: AlertInstance = { ruleId: rule.id, groupKey, labels, state: 'pending', since: t, value, lastNotified: null };
      this.states.set(key, inst);
      this.record(rule, inst, 'ok', 'pending', value, t, 'none');
      if (rule.forSec === 0) await this.fire(rule, inst, t);
      else this.persist(inst);
      return;
    }

    cur.value = value;
    if (cond) {
      if (cur.state === 'pending' && t - cur.since >= rule.forSec * 1000) await this.fire(rule, cur, t);
      else if (cur.state === 'firing' && rule.repeatSec && cur.lastNotified !== null && t - cur.lastNotified >= rule.repeatSec * 1000) {
        const r = await this.notifier.send({ rule, state: 'repeat', labels: cur.labels, value, at: t });
        cur.lastNotified = t;
        void r;
        this.persist(cur);
      } else this.persist(cur);
      return;
    }

    // la condición dejó de cumplirse
    this.states.delete(key);
    this.store.db.prepare(`DELETE FROM alert_state WHERE rule_id=? AND group_key=?`).run(rule.id, groupKey);
    if (cur.state === 'firing') {
      const delivery = await this.notifier.send({ rule, state: 'resolved', labels: cur.labels, value, at: t });
      this.record(rule, cur, 'firing', 'ok', value, t, delivery);
    } // pending → ok: sin evento ni notificación (era un pico)
  }

  private async fire(rule: Rule, inst: AlertInstance, t: number): Promise<void> {
    inst.state = 'firing';
    inst.lastNotified = t;
    this.persist(inst);
    const delivery = await this.notifier.send({ rule, state: 'firing', labels: inst.labels, value: inst.value, at: t });
    this.record(rule, inst, 'pending', 'firing', inst.value, t, delivery);
  }

  private persist(s: AlertInstance): void {
    this.store.db.prepare(
      `INSERT INTO alert_state(rule_id, group_key, state, since, value, labels, last_notified) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(rule_id, group_key) DO UPDATE SET state=excluded.state, value=excluded.value, last_notified=excluded.last_notified`,
    ).run(s.ruleId, s.groupKey, s.state, s.since, s.value, JSON.stringify(s.labels), s.lastNotified);
  }

  private record(rule: Rule, s: AlertInstance, from: AlertEvent['from'], to: AlertEvent['to'], value: number | null, ts: number, delivery: AlertEvent['delivery']): void {
    // Solo las transiciones relevantes para humanos: a firing y resolved (pending se guarda como contexto).
    this.store.db.prepare(
      `INSERT INTO alert_events(ts, rule_id, rule_name, group_key, labels, from_state, to_state, value, delivery) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(ts, rule.id, rule.name, s.groupKey, JSON.stringify(s.labels), from, to, value, delivery);
    this.store.db.prepare(`DELETE FROM alert_events WHERE id <= (SELECT max(id) FROM alert_events) - 5000`).run();
  }
}
