import { Board, type Op } from './board.js';
import { BoardDoc } from './doc.js';
import { Clock } from './hlc.js';
import type { Peer, ServerMessage } from './protocol.js';

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export type Status = 'connecting' | 'online' | 'offline';

export interface SyncOptions {
  url: string;
  boardId: string;
  clientId: string;
  name: string;
  color: string;
  createSocket: (url: string) => SocketLike;
  storage?: KV;
  now?: () => number;
  /** Backoff exponencial con jitter entre reconexiones. */
  backoff?: { minMs: number; maxMs: number };
  /** Si no llega ningún mensaje (ni heartbeat) en este tiempo, se considera caída la conexión. */
  deadAfterMs?: number;
}

interface Persisted {
  ops: Op[];
  outbox: Op[];
  since: number;
  epoch: string | null;
}

const OPEN = 1;
const BATCH = 200;

/**
 * Cliente offline-first:
 *  - Las ediciones se aplican al instante (optimista) y van a una bandeja de salida persistente.
 *  - Sin conexión se sigue trabajando; al reconectar se hace `hello(since)`, se recibe el delta y
 *    se reenvía la bandeja. Como el CRDT es idempotente, reenviar de más es siempre seguro.
 *  - Si el servidor cambió de "epoch" (compactación o pérdida de datos), se reenvía el estado local completo.
 */
export class SyncClient {
  readonly doc: BoardDoc;
  private readonly board = new Board();
  private readonly clock: Clock;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  private socket: SocketLike | null = null;
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private deadTimer: ReturnType<typeof setTimeout> | null = null;

  private outbox: Op[] = [];
  private since = 0;
  private epoch: string | null = null;
  private synced = false;
  private inflight: { batch: number; count: number } | null = null;
  private batchSeq = 0;

  status: Status = 'offline';
  peers: Peer[] = [];
  lastError: string | null = null;
  /** Cambia en cada notificación; sirve como snapshot para useSyncExternalStore. */
  revision = 0;

  constructor(private readonly opts: SyncOptions) {
    this.now = opts.now ?? Date.now;
    this.clock = new Clock(opts.clientId, this.now);
    this.doc = new BoardDoc(this.board, this.clock, Math.random, (ops) => this.commit(ops));
    this.restore();
  }

  // ---------- API pública ----------
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getRevision = (): number => this.revision;

  get pending(): number {
    return this.outbox.length;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopDeadTimer();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = s.onmessage = s.onerror = s.onopen = null;
      s.close();
    }
    this.setStatus('offline');
  }

  setPresence(focus: string | null, editing = false): void {
    this.send({ t: 'presence', focus, editing });
  }

  // ---------- persistencia local ----------
  private key = () => `collab:${this.opts.boardId}:${this.opts.clientId}`;

  private restore(): void {
    try {
      const raw = this.opts.storage?.get(this.key());
      if (!raw) return;
      const p = JSON.parse(raw) as Persisted;
      for (const op of p.ops) {
        this.board.apply(op);
        this.clock.receive(op.ts);
      }
      this.outbox = p.outbox ?? [];
      this.since = p.since ?? 0;
      this.epoch = p.epoch ?? null;
    } catch {
      /* almacenamiento corrupto: se ignora y se resincroniza desde el servidor */
    }
  }

  private persist(): void {
    try {
      const p: Persisted = { ops: this.board.snapshotOps(), outbox: this.outbox, since: this.since, epoch: this.epoch };
      this.opts.storage?.set(this.key(), JSON.stringify(p));
    } catch {
      /* cuota excedida, etc.: seguimos en memoria */
    }
  }

  // ---------- mutaciones locales ----------
  private commit(ops: Op[]): Op[] {
    if (ops.length === 0) return ops;
    this.outbox.push(...ops);
    this.persist();
    this.notify();
    this.flush();
    return ops;
  }

  // ---------- red ----------
  private open(): void {
    if (this.socket) return;
    this.setStatus('connecting');
    let s: SocketLike;
    try {
      s = this.opts.createSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = s;
    s.onopen = () => {
      this.attempt = 0;
      this.synced = false;
      this.inflight = null;
      this.armDeadTimer();
      this.send({
        t: 'hello',
        clientId: this.opts.clientId,
        name: this.opts.name,
        color: this.opts.color,
        since: this.since,
        epoch: this.epoch,
      });
    };
    s.onmessage = (ev) => {
      this.armDeadTimer();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    s.onerror = () => {};
    s.onclose = () => {
      if (this.socket === s) this.socket = null;
      this.synced = false;
      this.inflight = null;
      this.peers = [];
      this.stopDeadTimer();
      this.setStatus('offline');
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const { minMs, maxMs } = this.opts.backoff ?? { minMs: 500, maxMs: 15_000 };
    const delay = Math.min(maxMs, minMs * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private armDeadTimer(): void {
    this.stopDeadTimer();
    const ms = this.opts.deadAfterMs ?? 40_000;
    this.deadTimer = setTimeout(() => this.socket?.close(), ms);
  }
  private stopDeadTimer(): void {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = null;
  }

  private send(msg: unknown): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'sync': {
        for (const op of msg.ops) this.receive(op);
        if (msg.done) {
          const epochChanged = this.epoch !== null && this.epoch !== msg.epoch;
          this.epoch = msg.epoch;
          this.since = msg.seq;
          this.synced = true;
          this.setStatus('online');
          // El servidor empezó una historia nueva: reafirmamos todo nuestro estado (idempotente).
          if (epochChanged) this.outbox = dedupe([...this.board.snapshotOps(), ...this.outbox]);
          this.persist();
          this.flush();
        }
        this.notify();
        break;
      }
      case 'ops': {
        for (const op of msg.ops) this.receive(op);
        this.since = Math.max(this.since, msg.seq);
        this.persist();
        this.notify();
        break;
      }
      case 'ack': {
        if (this.inflight && this.inflight.batch === msg.batch) {
          this.outbox.splice(0, this.inflight.count);
          this.inflight = null;
          this.persist();
          this.notify();
          this.flush();
        }
        break;
      }
      case 'presence':
        this.peers = msg.peers.filter((p) => p.id !== this.opts.clientId);
        this.notify();
        break;
      case 'error':
        this.lastError = msg.message;
        if (msg.code === 'rejected' && this.inflight) {
          // Un lote inválido bloquearía la cola para siempre: lo descartamos.
          this.outbox.splice(0, this.inflight.count);
          this.inflight = null;
          this.persist();
          this.flush();
        }
        this.notify();
        break;
      case 'hb':
        break;
    }
  }

  private receive(op: Op): void {
    this.clock.receive(op.ts);
    this.board.apply(op);
  }

  private flush(): void {
    if (!this.synced || this.inflight || this.outbox.length === 0) return;
    const ops = this.outbox.slice(0, BATCH);
    const batch = ++this.batchSeq;
    this.inflight = { batch, count: ops.length };
    this.send({ t: 'ops', batch, ops });
  }

  private setStatus(s: Status): void {
    if (this.status === s) return;
    this.status = s;
    this.notify();
  }

  private notify(): void {
    this.revision++;
    for (const l of this.listeners) l();
  }
}

function dedupe(ops: Op[]): Op[] {
  const seen = new Set<string>();
  return ops.filter((o) => {
    const k = `${o.ts}|${o.e}|${o.id}|${o.f}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
