import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { SyncClient, type SocketLike } from '@collab/core';
import { getIdentity } from './identity';

/** Crea el cliente de sincronización de un tablero y lo expone como store de React. */
export function useBoard(boardId: string, seedIfNew: boolean) {
  const client = useMemo(() => {
    const me = getIdentity();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return new SyncClient({
      url: `${proto}://${location.host}/ws?board=${boardId}`,
      boardId,
      clientId: me.clientId,
      name: me.name,
      color: me.color,
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      storage: {
        get: (k) => localStorage.getItem(k),
        set: (k, v) => localStorage.setItem(k, v),
      },
    });
  }, [boardId]);

  const seeded = useRef(false);
  useEffect(() => {
    // Solo quien CREA el tablero lo siembra: evita columnas duplicadas si dos personas entran a la vez.
    if (seedIfNew && !seeded.current && client.doc.view().length === 0) {
      seeded.current = true;
      client.doc.seedDefaults();
    }
    client.connect();
    return () => client.close();
  }, [client, seedIfNew]);

  const revision = useSyncExternalStore(client.subscribe, client.getRevision);
  // `revision` cambia en cada mutación; la vista derivada se recalcula solo entonces.
  const columns = useMemo(() => client.doc.view(), [client, revision]);
  return { client, columns, status: client.status, peers: client.peers, pending: client.pending, error: client.lastError };
}
