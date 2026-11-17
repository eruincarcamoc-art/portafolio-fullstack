import type { WebSocket } from 'ws';
import { Board, LIMITS, MAX_DRIFT_MS, parseTs, type Op, type Peer, type ServerMessage } from '@collab/core';
import type { OpLog } from './oplog.js';

const SYNC_CHUNK = 500;

export interface Conn {
  ws: WebSocket;
  peer: Peer | null; // null hasta recibir `hello`
  /** Cubo de tokens para limitar mensajes por segundo. */
  tokens: number;
  lastRefill: number;
}

export interface RoomOptions {
  now?: () => number;
  /** Compactar cuando el log supere `factor * |snapshot| + slack`. */
  compactFactor?: number;
  compactSlack?: number;
}

/**
 * Una sala = un tablero en memoria + su log persistente + sus conexiones.
 * Todas las escrituras de una sala se serializan en una cola (`queue`), así el orden en disco
 * coincide con el orden de difusión y el contador `seq` es consistente.
 */
export class Room {
  private board = new Board();
  private log: Op[] = [];
  private epoch = '';
  readonly conns = new Set<Conn>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private compacting = false;
  closed = false;
  lastActive = Date.now();

  private constructor(
    readonly id: string,
    private readonly store: OpLog,
    private readonly opts: RoomOptions,
    private readonly onFatal: (room: Room) => void,
  ) {
    this.now = opts.now ?? Date.now;
  }

  static async open(id: string, store: OpLog, opts: RoomOptions, onFatal: (r: Room) => void): Promise<Room> {
    const room = new Room(id, store, opts, onFatal);
    const loaded = await store.load(id);
    room.epoch = loaded.epoch;
    // Solo se conservan las operaciones efectivas: el log queda siempre "limpio".
    room.log = room.board.applyAll(loaded.ops);
    return room;
  }

  get seq(): number {
    return this.log.length;
  }

  // ---------- conexiones ----------
  join(conn: Conn, hello: { since: number; epoch: string | null }): void {
    this.conns.add(conn);
    // Mismo epoch => delta desde `since`. Distinto (compactación / servidor reiniciado) => historia completa.
    const from = hello.epoch === this.epoch ? Math.min(hello.since, this.log.length) : 0;
    const ops = this.log.slice(from);
    for (let i = 0; i < Math.max(1, Math.ceil(ops.length / SYNC_CHUNK)); i++) {
      const chunk = ops.slice(i * SYNC_CHUNK, (i + 1) * SYNC_CHUNK);
      const done = (i + 1) * SYNC_CHUNK >= ops.length;
      this.send(conn, { t: 'sync', epoch: this.epoch, seq: this.seq, ops: chunk, done });
    }
    this.broadcastPresence();
  }

  leave(conn: Conn): void {
    if (this.conns.delete(conn)) this.broadcastPresence();
    this.lastActive = Date.now();
  }

  setPresence(conn: Conn, focus: string | null, editing: boolean): void {
    if (!conn.peer) return;
    conn.peer.focus = focus;
    conn.peer.editing = editing;
    this.broadcastPresence();
  }

  // ---------- escritura ----------
  /** Valida límites, aplica, persiste y difunde. Devuelve una promesa que resuelve al terminar. */
  submit(conn: Conn, batch: number, ops: Op[]): Promise<void> {
    const run = async () => {
      if (this.closed) return;
      this.lastActive = Date.now();

      // 1) Defensa del reloj: ts desmesuradamente futuros romperían el LWW para todos.
      const maxWall = this.now() + MAX_DRIFT_MS;
      if (ops.some((o) => (parseTs(o.ts)?.wall ?? Infinity) > maxWall)) {
        return this.reject(conn, 'Timestamp too far in the future');
      }
      // 2) Límites de tamaño del tablero.
      const newCards = new Set(ops.filter((o) => o.e === 'card' && !this.board.has('card', o.id)).map((o) => o.id));
      const newCols = new Set(ops.filter((o) => o.e === 'column' && !this.board.has('column', o.id)).map((o) => o.id));
      if (this.board.cardCount + newCards.size > LIMITS.maxCards || this.board.columnCount + newCols.size > LIMITS.maxColumns) {
        return this.reject(conn, 'Board size limit reached');
      }

      // 3) Solo se registran y difunden las operaciones que cambian el estado.
      const effective = this.board.applyAll(ops);
      try {
        if (effective.length) {
          await this.store.append(this.id, effective);
          this.log.push(...effective);
        }
      } catch (err) {
        // Memoria y disco divergen: descartamos la sala; los clientes reconectan y releen del disco.
        this.closed = true;
        this.onFatal(this);
        for (const c of this.conns) c.ws.close(1011, 'storage failure');
        throw err;
      }
      this.send(conn, { t: 'ack', batch, seq: this.seq });
      if (effective.length) {
        for (const c of this.conns) if (c !== conn && c.peer) this.send(c, { t: 'ops', seq: this.seq, ops: effective });
        void this.maybeCompact();
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  private reject(conn: Conn, message: string): void {
    this.send(conn, { t: 'error', code: 'rejected', message });
  }

  private async maybeCompact(): Promise<void> {
    const snapshot = this.board.snapshotOps();
    const limit = (this.opts.compactFactor ?? 2) * snapshot.length + (this.opts.compactSlack ?? 500);
    if (this.compacting || this.log.length <= limit) return;
    this.compacting = true;
    // Entra en la misma cola que las escrituras: nadie escribe mientras se reemplaza el fichero.
    this.queue = this.queue.then(async () => {
      try {
        const snap = this.board.snapshotOps();
        this.epoch = await this.store.compact(this.id, snap);
        this.log = snap;
      } finally {
        this.compacting = false;
      }
    }).catch(() => {});
  }

  /** Espera a que terminen las escrituras en curso (tests y apagado ordenado). */
  async idle(): Promise<void> {
    await this.queue;
  }

  // ---------- difusión ----------
  heartbeat(): void {
    for (const c of this.conns) this.send(c, { t: 'hb' });
  }

  private broadcastPresence(): void {
    const peers = [...this.conns].map((c) => c.peer).filter((p): p is Peer => p !== null);
    for (const c of this.conns) this.send(c, { t: 'presence', peers });
  }

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
  }

  get stats() {
    return { cards: this.board.cardCount, columns: this.board.columnCount, log: this.log.length, epoch: this.epoch, peers: this.conns.size };
  }
}
