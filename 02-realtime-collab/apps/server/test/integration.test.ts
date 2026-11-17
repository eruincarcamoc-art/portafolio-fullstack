import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { SyncClient, encodeTs, type KV, type SocketLike } from '@collab/core';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.js';
import { FileOpLog, MemoryOpLog, type OpLog } from '../src/oplog.js';

const BOARD = 'board-test-0123456789abcdef';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function server(opts: Partial<ServerOptions> & { store?: OpLog } = {}, port = 0): Promise<RunningServer> {
  const s = await startServer(port, { store: new MemoryOpLog(), ...opts });
  cleanups.push(() => s.close());
  return s;
}

const memoryKV = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
};

function client(s: RunningServer, id: string, extra: { storage?: KV; board?: string } = {}): SyncClient {
  const c = new SyncClient({
    url: `ws://127.0.0.1:${s.port}/ws?board=${extra.board ?? BOARD}`,
    boardId: extra.board ?? BOARD,
    clientId: id,
    name: id.toUpperCase(),
    color: '#336699',
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    storage: extra.storage,
    backoff: { minMs: 20, maxMs: 100 },
  });
  cleanups.push(() => c.close());
  return c;
}

async function waitFor(cond: () => boolean | Promise<boolean>, what = 'condition', ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const titles = (c: SyncClient) => c.doc.view().map((col) => [col.title, col.cards.map((k) => k.title)]);
const same = (a: SyncClient, b: SyncClient) => JSON.stringify(a.doc.view()) === JSON.stringify(b.doc.view());
const online = (c: SyncClient) => c.status === 'online';

describe('real-time sync', () => {
  it('propagates edits between two clients in both directions', async () => {
    const s = await server();
    const a = client(s, 'a');
    const b = client(s, 'b');
    a.connect();
    b.connect();
    await waitFor(() => online(a) && online(b), 'both online');

    a.doc.seedDefaults();
    await waitFor(() => b.doc.view().length === 3, 'b sees columns');
    const todo = a.doc.view()[0]!.id;
    a.doc.createCard(todo, 'Write tests');
    await waitFor(() => b.doc.view()[0]!.cards.length === 1, 'b sees card');

    const card = b.doc.view()[0]!.cards[0]!;
    b.doc.moveCard(card.id, b.doc.view()[2]!.id, 0);
    await waitFor(() => a.doc.view()[2]!.cards.length === 1, 'a sees move');
    expect(same(a, b)).toBe(true);
    await waitFor(() => a.pending === 0 && b.pending === 0, 'outboxes drained');
  });

  it('a late joiner receives the full history', async () => {
    const s = await server();
    const a = client(s, 'a');
    a.connect();
    await waitFor(() => online(a));
    a.doc.seedDefaults();
    for (let i = 0; i < 30; i++) a.doc.createCard(a.doc.view()[0]!.id, `task ${i}`);
    await waitFor(() => a.pending === 0, 'flushed');

    const late = client(s, 'late');
    late.connect();
    await waitFor(() => online(late) && late.doc.view()[0]?.cards.length === 30, 'late joiner synced');
    expect(same(a, late)).toBe(true);
  });

  it('shows presence of other participants and removes them on disconnect', async () => {
    const s = await server();
    const a = client(s, 'a');
    const b = client(s, 'b');
    a.connect();
    b.connect();
    await waitFor(() => a.peers.length === 1 && b.peers.length === 1, 'peers visible');
    b.setPresence('card123', true);
    await waitFor(() => a.peers[0]?.focus === 'card123' && a.peers[0]?.editing === true, 'focus relayed');
    b.close();
    await waitFor(() => a.peers.length === 0, 'peer removed');
  });
});

describe('offline-first', () => {
  it('edits made offline on both sides merge after reconnecting', async () => {
    const s = await server();
    const a = client(s, 'a');
    const b = client(s, 'b');
    a.connect();
    b.connect();
    await waitFor(() => online(a) && online(b));
    a.doc.seedDefaults();
    await waitFor(() => b.doc.view().length === 3);
    a.doc.createCard(a.doc.view()[0]!.id, 'shared');
    await waitFor(() => b.doc.view()[0]!.cards.length === 1);

    a.close(); // A se queda sin red
    await waitFor(() => a.status === 'offline');
    const shared = a.doc.view()[0]!.cards[0]!;
    a.doc.editCard(shared.id, { title: 'edited by A' });
    a.doc.createCard(a.doc.view()[1]!.id, 'A offline card');
    expect(a.pending).toBeGreaterThan(0);

    b.doc.createCard(b.doc.view()[0]!.id, 'B card');
    b.doc.moveCard(shared.id, b.doc.view()[2]!.id, 0); // B mueve la tarjeta que A editó

    a.connect();
    await waitFor(() => online(a) && a.pending === 0 && same(a, b), 'converged after reconnect');

    const v = a.doc.view();
    expect(v[2]!.cards.map((c) => c.title)).toEqual(['edited by A']); // edición de A + movimiento de B, ambos conservados
    expect(v[1]!.cards.map((c) => c.title)).toEqual(['A offline card']);
    expect(v[0]!.cards.map((c) => c.title)).toEqual(['B card']);
  });

  it('survives a page reload: local state and pending ops are restored from storage', async () => {
    const s = await server();
    const storage = memoryKV();
    const first = client(s, 'a', { storage });
    first.doc.seedDefaults(); // sin conectar nunca: todo queda en la bandeja de salida
    first.doc.createCard(first.doc.view()[0]!.id, 'drafted offline');
    expect(first.pending).toBeGreaterThan(0);
    first.close();

    const reloaded = client(s, 'a', { storage });
    expect(titles(reloaded)[0]).toEqual(['To do', ['drafted offline']]); // visible al instante, sin red
    reloaded.connect();
    await waitFor(() => online(reloaded) && reloaded.pending === 0, 'outbox flushed');

    const observer = client(s, 'b');
    observer.connect();
    await waitFor(() => same(observer, reloaded) && observer.doc.view().length === 3, 'server has the data');
  });

  it('reconnects automatically after the server drops the connection', async () => {
    const s = await server();
    const a = client(s, 'a');
    a.connect();
    await waitFor(() => online(a));
    for (const room of s.rooms.values()) for (const conn of room.conns) conn.ws.terminate();
    await waitFor(() => a.status !== 'online', 'noticed disconnect');
    a.doc.seedDefaults();
    await waitFor(() => online(a) && a.pending === 0, 'auto-reconnected and flushed');
  });
});

describe('durability', () => {
  it('persists to disk and restores after a server restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'collab-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const s1 = await startServer(0, { store: new FileOpLog(dir) });
    const a = client(s1, 'a');
    a.connect();
    await waitFor(() => online(a));
    a.doc.seedDefaults();
    a.doc.createCard(a.doc.view()[0]!.id, 'persisted');
    await waitFor(() => a.pending === 0);
    a.close();
    await s1.close();

    const raw = await readFile(path.join(dir, `${BOARD}.jsonl`), 'utf8');
    expect(raw.split('\n')[0]).toMatch(/"epoch"/);

    const s2 = await server({ store: new FileOpLog(dir) });
    const b = client(s2, 'b');
    b.connect();
    await waitFor(() => online(b) && b.doc.view()[0]?.cards[0]?.title === 'persisted', 'restored from disk');
  });

  it('tolerates a truncated last line (crash during append)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'collab-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = new FileOpLog(dir);
    await store.append(BOARD, [{ ts: encodeTs(1, 0, 'x'), e: 'column', id: 'c1', f: 'title', v: 'Ok' }]);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path.join(dir, `${BOARD}.jsonl`), '{"ts":"broken');
    const loaded = await store.load(BOARD);
    expect(loaded.ops).toHaveLength(1);
  });

  it('compacts the log, bumps the epoch, and clients still converge (keeping their offline edits)', async () => {
    const store = new MemoryOpLog();
    const s = await server({ store, room: { compactSlack: 20, compactFactor: 1 } });
    const a = client(s, 'a');
    const b = client(s, 'b');
    a.connect();
    b.connect();
    await waitFor(() => online(a) && online(b));
    a.doc.seedDefaults();
    const card = (a.doc.createCard(a.doc.view()[0]!.id, 'v0'), a.doc.view()[0]!.cards[0]!);
    await waitFor(() => a.pending === 0 && b.doc.view()[0]?.cards.length === 1);
    const epoch0 = [...s.rooms.values()][0]!.stats.epoch;

    b.close();
    await waitFor(() => b.status === 'offline');
    b.doc.createCard(b.doc.view()[1]!.id, 'offline in b');

    for (let i = 1; i <= 80; i++) {
      a.doc.editCard(card.id, { title: `v${i}` });
      if (i % 10 === 0) await waitFor(() => a.pending === 0);
    }
    const room = [...s.rooms.values()][0]!;
    await waitFor(() => room.stats.epoch !== epoch0, 'log compacted');
    await room.idle();
    expect(room.stats.log).toBeLessThan(40); // 80+ ediciones colapsadas a una por registro

    b.connect();
    await waitFor(() => online(b) && b.pending === 0 && same(a, b), 'b converged after epoch change');
    expect(titles(a)[0]).toEqual(['To do', ['v80']]);
    expect(titles(a)[1]).toEqual(['In progress', ['offline in b']]);
  });

  it('re-asserts local state if the server lost its data (new epoch)', async () => {
    const storage = memoryKV();
    const s1 = await server();
    const a = client(s1, 'a', { storage });
    a.connect();
    await waitFor(() => online(a));
    a.doc.seedDefaults();
    await waitFor(() => a.pending === 0);
    a.close();
    await s1.close();

    const s2 = await server(); // memoria nueva: no sabe nada del tablero
    const a2 = new SyncClient({
      url: `ws://127.0.0.1:${s2.port}/ws?board=${BOARD}`,
      boardId: BOARD, clientId: 'a', name: 'A', color: '#336699', storage,
      createSocket: (u) => new WebSocket(u) as unknown as SocketLike,
    });
    cleanups.push(() => a2.close());
    a2.connect();
    await waitFor(() => online(a2) && a2.pending === 0, 'resynced');
    const fresh = client(s2, 'fresh');
    fresh.connect();
    await waitFor(() => fresh.doc.view().length === 3, 'server repopulated by the client');
  });
});

describe('hardening', () => {
  const rawSocket = (s: RunningServer, board = BOARD, headers: Record<string, string> = {}) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?board=${board}`, { headers });
      cleanups.push(() => ws.close());
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  const hello = { t: 'hello', clientId: 'raw', name: 'Raw', color: '#112233', since: 0, epoch: null };
  const nextMessage = (ws: WebSocket, pred: (m: any) => boolean) =>
    new Promise<any>((resolve) => {
      const h = (d: any) => {
        const m = JSON.parse(d.toString());
        if (pred(m)) { ws.off('message', h); resolve(m); }
      };
      ws.on('message', h);
    });
  const closed = (ws: WebSocket) => new Promise<number>((r) => ws.on('close', (code) => r(code)));

  it('rejects invalid board ids (path traversal) and disallowed origins', async () => {
    const s = await server({ allowedOrigins: ['https://app.example.com'] });
    await expect(rawSocket(s, '../../etc/passwd', { origin: 'https://app.example.com' })).rejects.toThrow();
    await expect(rawSocket(s, BOARD, { origin: 'https://evil.example.com' })).rejects.toThrow();
    await expect(rawSocket(s, BOARD)).rejects.toThrow(); // sin Origin tampoco
    const ok = await rawSocket(s, BOARD, { origin: 'https://app.example.com' });
    expect(ok.readyState).toBe(1);
  });

  it('closes the connection on malformed messages or missing hello', async () => {
    const s = await server();
    const ws1 = await rawSocket(s);
    const c1 = closed(ws1);
    ws1.send('not json');
    expect(await c1).toBe(1003);

    const ws2 = await rawSocket(s);
    const c2 = closed(ws2);
    ws2.send(JSON.stringify({ t: 'ops', batch: 1, ops: [] }));
    expect(await c2).toBe(1002);
  });

  it('rejects invalid ops without dropping the connection, and never stores them', async () => {
    const s = await server();
    const ws = await rawSocket(s);
    ws.send(JSON.stringify(hello));
    await nextMessage(ws, (m) => m.t === 'sync' && m.done);
    ws.send(JSON.stringify({ t: 'ops', batch: 1, ops: [{ ts: encodeTs(1, 0, 'raw'), e: 'card', id: 'x', f: 'title', v: 123 }] }));
    const err = await nextMessage(ws, (m) => m.t === 'error');
    expect(err.code).toBe('rejected');
    expect(ws.readyState).toBe(1);
    expect([...s.rooms.values()][0]!.stats.log).toBe(0);
  });

  it('rejects timestamps from the far future (clock poisoning)', async () => {
    const s = await server();
    const ws = await rawSocket(s);
    ws.send(JSON.stringify(hello));
    await nextMessage(ws, (m) => m.t === 'sync' && m.done);
    const future = encodeTs(Date.now() + 5 * 3600 * 1000, 0, 'raw');
    ws.send(JSON.stringify({ t: 'ops', batch: 1, ops: [{ ts: future, e: 'column', id: 'c1', f: 'title', v: 'x' }] }));
    expect((await nextMessage(ws, (m) => m.t === 'error')).message).toMatch(/future/);
    expect([...s.rooms.values()][0]!.stats.log).toBe(0);
  });

  it('enforces board size limits', async () => {
    const s = await server();
    const ws = await rawSocket(s);
    ws.send(JSON.stringify(hello));
    await nextMessage(ws, (m) => m.t === 'sync' && m.done);
    const ops = Array.from({ length: 51 }, (_, i) => ({ ts: encodeTs(1000 + i, 0, 'raw'), e: 'column', id: `c${i}`, f: 'title', v: 'x' }));
    ws.send(JSON.stringify({ t: 'ops', batch: 1, ops }));
    expect((await nextMessage(ws, (m) => m.t === 'error')).message).toMatch(/limit/);
  });

  it('disconnects clients that flood the server', async () => {
    const s = await server({ rateLimit: { perSecond: 5, burst: 10 } });
    const ws = await rawSocket(s);
    const c = closed(ws);
    ws.send(JSON.stringify(hello));
    for (let i = 0; i < 50; i++) ws.send(JSON.stringify({ t: 'presence', focus: null, editing: false }));
    expect(await c).toBe(1008);
  });

  it('exposes health and creates unguessable board ids', async () => {
    const s = await server();
    const health = await (await fetch(`http://127.0.0.1:${s.port}/health`)).json();
    expect(health.status).toBe('ok');
    const r = await fetch(`http://127.0.0.1:${s.port}/api/boards`, { method: 'POST' });
    const { id } = await r.json();
    expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});
