import { describe, it, expect } from 'vitest';
import { Board, BoardDoc, Clock, between, encodeTs, parseTs, MAX_DRIFT_MS, opsArray, clientMessage, type Op } from '../src/index.js';

/** PRNG determinista (mulberry32): los fallos son reproducibles con la misma semilla. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = <T,>(arr: T[], r: () => number): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

describe('HLC', () => {
  it('ticks are strictly increasing even if the physical clock stalls or goes back', () => {
    let now = 1000;
    const c = new Clock('a', () => now);
    const t1 = c.tick();
    const t2 = c.tick();
    now = 500; // el reloj retrocede
    const t3 = c.tick();
    expect(t1 < t2 && t2 < t3).toBe(true);
  });

  it('receive() makes later local events happen-after remote ones, despite skew', () => {
    const a = new Clock('a', () => 10_000);
    const b = new Clock('b', () => 1_000); // reloj de b muy atrasado
    const fromA = a.tick();
    b.receive(fromA);
    expect(b.tick() > fromA).toBe(true);
  });

  it('ignores timestamps absurdly far in the future (clock poisoning)', () => {
    const c = new Clock('a', () => 1_000);
    c.receive(encodeTs(1_000 + MAX_DRIFT_MS + 10_000, 0, 'evil'));
    expect(parseTs(c.tick())!.wall).toBe(1_000);
  });

  it('timestamps from different nodes never tie', () => {
    expect(new Clock('a', () => 5).tick()).not.toBe(new Clock('b', () => 5).tick());
  });

  it('string order equals chronological order', () => {
    expect(encodeTs(35, 0, 'a') < encodeTs(36, 0, 'a')).toBe(true);
    expect(encodeTs(36, 0, 'a') < encodeTs(36, 1, 'a')).toBe(true);
    expect(encodeTs(1_800_000_000_000, 0, 'a') > encodeTs(999_999_999_999, 0, 'a')).toBe(true);
  });
});

describe('fractional indexing', () => {
  it('always returns a key strictly between its neighbours', () => {
    const r = rng(7);
    let keys: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(r() * (keys.length + 1));
      const k = between(keys[at - 1] ?? null, keys[at] ?? null);
      if (keys[at - 1] !== undefined) expect(k > keys[at - 1]!).toBe(true);
      if (keys[at] !== undefined) expect(k < keys[at]!).toBe(true);
      expect(k.endsWith('0')).toBe(false);
      keys.splice(at, 0, k);
    }
    expect([...keys].sort()).toEqual(keys); // el orden de inserción coincide con el lexicográfico
  });

  it('grows slowly when appending at the end', () => {
    let k: string | null = null;
    for (let i = 0; i < 1000; i++) k = between(k, null);
    expect(k!.length).toBeLessThan(40);
  });

  it('degrades gracefully when two replicas picked the same slot (a >= b)', () => {
    const k = between('V', 'V');
    expect(k > 'V').toBe(true);
  });
});

describe('Board (LWW CRDT)', () => {
  const op = (ts: string, f: string, v: Op['v'], id = 'c1', e: Op['e'] = 'card'): Op => ({ ts, e, id, f, v });

  it('last writer wins regardless of arrival order', () => {
    const early = op(encodeTs(1, 0, 'a'), 'title', 'early');
    const late = op(encodeTs(2, 0, 'b'), 'title', 'late');
    const x = new Board();
    x.apply(early); x.apply(late);
    const y = new Board();
    y.apply(late); y.apply(early);
    expect(x.fingerprint()).toBe(y.fingerprint());
  });

  it('is idempotent and reports whether an op changed anything', () => {
    const b = new Board();
    const o = op(encodeTs(1, 0, 'a'), 'title', 'x');
    expect(b.apply(o)).toBe(true);
    expect(b.apply(o)).toBe(false);
    expect(b.apply(op(encodeTs(0, 0, 'a'), 'title', 'older'))).toBe(false);
  });

  it('a snapshot is equivalent to the full history', () => {
    const b = new Board();
    for (let i = 0; i < 50; i++) b.apply(op(encodeTs(i + 1, 0, 'a'), 'title', `v${i}`));
    const fromSnapshot = new Board();
    fromSnapshot.applyAll(b.snapshotOps());
    expect(fromSnapshot.fingerprint()).toBe(b.fingerprint());
    expect(b.snapshotOps()).toHaveLength(1);
  });
});

describe('convergence under chaos', () => {
  function simulate(seed: number, replicas = 4, steps = 120) {
    const r = rng(seed);
    let fakeNow = 1_700_000_000_000;
    const docs = Array.from({ length: replicas }, (_, i) => {
      // cada réplica tiene un reloj con desfase propio (hasta ±30 s)
      const skew = Math.floor((r() - 0.5) * 60_000);
      const emitted: Op[] = [];
      const doc = new BoardDoc(new Board(), new Clock(`n${i}`, () => fakeNow + skew), r, (ops) => emitted.push(...ops));
      return { doc, emitted };
    });
    docs[0]!.doc.seedDefaults();

    for (let s = 0; s < steps; s++) {
      fakeNow += Math.floor(r() * 50);
      const me = docs[Math.floor(r() * replicas)]!;
      const view = me.doc.view();
      const cards = view.flatMap((c) => c.cards);
      const pick = r();
      if (view.length === 0 || pick < 0.08) me.doc.createColumn(`col${s}`);
      else if (pick < 0.35 || cards.length === 0) me.doc.createCard(view[Math.floor(r() * view.length)]!.id, `card${s}`);
      else if (pick < 0.6) me.doc.editCard(cards[Math.floor(r() * cards.length)]!.id, { title: `edit${s}` });
      else if (pick < 0.85) me.doc.moveCard(cards[Math.floor(r() * cards.length)]!.id, view[Math.floor(r() * view.length)]!.id, Math.floor(r() * 5));
      else if (pick < 0.93) me.doc.deleteCard(cards[Math.floor(r() * cards.length)]!.id);
      else if (pick < 0.96) me.doc.moveColumn(view[Math.floor(r() * view.length)]!.id, Math.floor(r() * 4));
      else me.doc.deleteColumn(view[Math.floor(r() * view.length)]!.id);

      // sincronizaciones parciales aleatorias: lotes entregados desordenados y con duplicados
      if (r() < 0.15) {
        const to = docs[Math.floor(r() * replicas)]!;
        const from = docs[Math.floor(r() * replicas)]!;
        for (const op of shuffle([...from.emitted, ...from.emitted.slice(0, 5)], r)) to.doc.board.apply(op);
      }
    }
    // entrega final: cada réplica recibe TODO lo emitido, barajado y con duplicados
    const all = docs.flatMap((d) => d.emitted);
    for (const d of docs) for (const op of shuffle([...all, ...all.slice(0, 20)], r)) d.doc.board.apply(op);
    return docs.map((d) => d.doc);
  }

  for (const seed of [1, 2, 3, 42, 1337, 99999, 2024, 31337]) {
    it(`all replicas converge to the same state (seed ${seed})`, () => {
      const docs = simulate(seed);
      const fp = docs[0]!.board.fingerprint();
      for (const d of docs) expect(d.board.fingerprint()).toBe(fp);
      expect(JSON.stringify(docs[1]!.view())).toBe(JSON.stringify(docs[0]!.view()));
    });
  }

  it('the view is always well-formed: no card in two columns, ordered, no ghosts', () => {
    for (const seed of [5, 6, 7]) {
      const view = simulate(seed)[0]!.view();
      const seen = new Set<string>();
      for (const col of view) {
        expect(col.cards.map((c) => c.pos)).toEqual([...col.cards.map((c) => c.pos)].sort());
        for (const card of col.cards) {
          expect(seen.has(card.id)).toBe(false);
          seen.add(card.id);
          expect(card.col).toBe(col.id);
        }
      }
    }
  });

  it('a concurrent move is atomic: column and position come from the same writer', () => {
    const emitted: Op[][] = [[], []];
    const mk = (i: number) => new BoardDoc(new Board(), new Clock(`n${i}`, () => 1_000_000), Math.random, (o) => emitted[i]!.push(...o));
    const a = mk(0);
    const b = mk(1);
    a.seedDefaults();
    const [todo, doing, done] = a.view();
    a.createCard(todo!.id, 'task');
    b.board.applyAll([...emitted[0]!]);
    const card = a.view()[0]!.cards[0]!;
    a.moveCard(card.id, doing!.id, 0);
    b.moveCard(card.id, done!.id, 0);
    a.board.applyAll(emitted[1]!);
    b.board.applyAll(emitted[0]!);
    expect(a.board.fingerprint()).toBe(b.board.fingerprint());
    const where = a.view().find((c) => c.cards.length)!;
    expect([doing!.id, done!.id]).toContain(where.id);
  });

  it('editing and deleting concurrently: later writer wins per field, delete is not resurrected by an older edit', () => {
    const mk = (i: number, t: number) => new BoardDoc(new Board(), new Clock(`n${i}`, () => t), Math.random, () => {});
    const a = mk(0, 1000);
    const ops = [...a.seedDefaults(), ...a.createCard(a.view()[0]!.id, 'x')];
    const cardId = ops.find((o) => o.e === 'card')!.id;
    const del: Op = { ts: encodeTs(5000, 0, 'n1'), e: 'card', id: cardId, f: 'del', v: true };
    const staleEdit: Op = { ts: encodeTs(4000, 0, 'n2'), e: 'card', id: cardId, f: 'title', v: 'edited' };
    for (const order of [[del, staleEdit], [staleEdit, del]]) {
      const b = new Board();
      b.applyAll(ops);
      b.applyAll(order);
      expect(b.view().flatMap((c) => c.cards)).toHaveLength(0);
    }
  });
});

describe('protocol validation', () => {
  const ts = encodeTs(1, 0, 'a');
  it('accepts well-formed ops and rejects malformed ones', () => {
    expect(opsArray.safeParse([{ ts, e: 'card', id: 'abc', f: 'title', v: 'hi' }]).success).toBe(true);
    expect(opsArray.safeParse([{ ts, e: 'card', id: 'abc', f: 'title', v: 5 }]).success).toBe(false); // tipo erróneo
    expect(opsArray.safeParse([{ ts, e: 'card', id: 'abc', f: 'nope', v: 'x' }]).success).toBe(false); // campo desconocido
    expect(opsArray.safeParse([{ ts, e: 'card', id: '../etc', f: 'title', v: 'x' }]).success).toBe(false); // id peligroso
    expect(opsArray.safeParse([{ ts: 'bad', e: 'card', id: 'abc', f: 'title', v: 'x' }]).success).toBe(false);
    expect(opsArray.safeParse([{ ts, e: 'card', id: 'abc', f: 'title', v: 'x'.repeat(301) }]).success).toBe(false);
    expect(opsArray.safeParse([{ ts, e: 'card', id: 'abc', f: 'place', v: 'col1:V' }]).success).toBe(true);
    expect(opsArray.safeParse([{ ts, e: 'card', id: 'abc', f: 'place', v: 'col1:V0' }]).success).toBe(false);
  });
  it('limits batch size', () => {
    const many = Array.from({ length: 501 }, () => ({ ts, e: 'card', id: 'abc', f: 'del', v: true }));
    expect(opsArray.safeParse(many).success).toBe(false);
  });
  it('validates client messages', () => {
    expect(clientMessage.safeParse({ t: 'hello', clientId: 'c1', name: 'Ana', color: '#aabbcc', since: 0, epoch: null }).success).toBe(true);
    expect(clientMessage.safeParse({ t: 'hello', clientId: 'c1', name: '', color: 'red', since: -1, epoch: null }).success).toBe(false);
    expect(clientMessage.safeParse({ t: 'evil' }).success).toBe(false);
  });
});
