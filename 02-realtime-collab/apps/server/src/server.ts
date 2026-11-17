import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { clientMessage } from '@collab/core';
import { Room, type Conn, type RoomOptions } from './room.js';
import type { OpLog } from './oplog.js';

export interface ServerOptions {
  store: OpLog;
  /** Orígenes permitidos para CORS y WebSocket. `*` = cualquiera (solo desarrollo). */
  allowedOrigins?: string[];
  heartbeatMs?: number;
  /** Mensajes por segundo permitidos por conexión (cubo de tokens). */
  rateLimit?: { perSecond: number; burst: number };
  maxPeersPerRoom?: number;
  room?: RoomOptions;
  log?: (msg: string, extra?: object) => void;
}

const BOARD_ID = /^[A-Za-z0-9_-]{16,64}$/;

export interface RunningServer {
  server: http.Server;
  port: number;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

export async function startServer(port: number, opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  const allowed = opts.allowedOrigins ?? ['*'];
  const rate = opts.rateLimit ?? { perSecond: 40, burst: 120 };
  const maxPeers = opts.maxPeersPerRoom ?? 50;
  const rooms = new Map<string, Room>();
  const opening = new Map<string, Promise<Room>>();

  const originOk = (origin: string | undefined) => allowed.includes('*') || (origin !== undefined && allowed.includes(origin));

  function getRoom(id: string): Promise<Room> {
    const existing = rooms.get(id);
    if (existing && !existing.closed) return Promise.resolve(existing);
    let p = opening.get(id);
    if (!p) {
      p = Room.open(id, opts.store, opts.room ?? {}, (r) => rooms.get(r.id) === r && rooms.delete(r.id)).then((r) => {
        rooms.set(id, r);
        return r;
      }).finally(() => opening.delete(id));
      opening.set(id, p);
    }
    return p;
  }

  // ---------- HTTP ----------
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && originOk(origin)) {
      res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    const url = new URL(req.url ?? '/', 'http://x');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(200, { status: 'ok', rooms: rooms.size, peers: [...rooms.values()].reduce((n, r) => n + r.conns.size, 0) });
    }
    // "Capability URL": el id es un secreto aleatorio de 192 bits; quien lo conoce, accede.
    if (req.method === 'POST' && url.pathname === '/api/boards') {
      return json(201, { id: randomBytes(18).toString('base64url') });
    }
    json(404, { error: 'not found' });
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const boardId = url.searchParams.get('board') ?? '';
    if (url.pathname !== '/ws' || !BOARD_ID.test(boardId) || !originOk(req.headers.origin)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, boardId));
  });

  async function onConnection(ws: WebSocket, boardId: string) {
    const conn: Conn = { ws, peer: null, tokens: rate.burst, lastRefill: Date.now() };
    let room: Room | null = null;
    let alive = true;
    ws.on('pong', () => (alive = true));
    (ws as any).__alive = () => alive;
    (ws as any).__reset = () => (alive = false);

    // Los mensajes que lleguen mientras se abre la sala se procesan en orden.
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (data) => {
      chain = chain.then(() => handle(data.toString())).catch((e) => log('handler error', { error: String(e) }));
    });
    ws.on('close', () => room?.leave(conn));
    ws.on('error', () => {});

    const fail = (code: number, reason: string) => ws.close(code, reason);

    async function handle(raw: string) {
      // Rate limit: cubo de tokens por conexión.
      const now = Date.now();
      conn.tokens = Math.min(rate.burst, conn.tokens + ((now - conn.lastRefill) / 1000) * rate.perSecond);
      conn.lastRefill = now;
      if (--conn.tokens < 0) return fail(1008, 'rate limit exceeded');

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return fail(1003, 'invalid json');
      }
      const parsed = clientMessage.safeParse(json);
      if (!parsed.success) {
        // Un lote de ops inválido no tumba la conexión: se rechaza y el cliente lo descarta.
        if ((json as any)?.t === 'ops' && room) {
          ws.send(JSON.stringify({ t: 'error', code: 'rejected', message: 'Invalid operations' }));
          return;
        }
        return fail(1003, 'invalid message');
      }
      const msg = parsed.data;

      if (msg.t === 'hello') {
        if (room) return; // hello duplicado: se ignora
        const r = await getRoom(boardId);
        if (r.conns.size >= maxPeers) return fail(1013, 'room full');
        room = r;
        conn.peer = { id: msg.clientId, name: msg.name, color: msg.color, focus: null, editing: false };
        room.join(conn, msg);
        return;
      }
      if (!room) return fail(1002, 'hello required');
      if (msg.t === 'ops') await room.submit(conn, msg.batch, msg.ops);
      else room.setPresence(conn, msg.focus, msg.editing);
    }
  }

  // Heartbeat: detecta conexiones muertas (ping/pong de protocolo) y mantiene vivos los proxies (mensaje `hb`).
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!(ws as any).__alive?.()) {
        ws.terminate();
        continue;
      }
      (ws as any).__reset?.();
      ws.ping();
    }
    for (const room of rooms.values()) room.heartbeat();
    // Salas vacías e inactivas se descargan de memoria (el log en disco permanece).
    for (const [id, room] of rooms) {
      if (room.conns.size === 0 && Date.now() - room.lastActive > 60_000) {
        void room.idle().then(() => rooms.get(id) === room && rooms.delete(id));
      }
    }
  }, opts.heartbeatMs ?? 15_000);
  hb.unref();

  await new Promise<void>((resolve) => server.listen(port, resolve));
  const actualPort = (server.address() as { port: number }).port;
  log('listening', { port: actualPort });

  return {
    server,
    port: actualPort,
    rooms,
    async close() {
      clearInterval(hb);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      await Promise.all([...rooms.values()].map((r) => r.idle()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
