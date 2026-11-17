const COLORS = ['#e5484d', '#f76b15', '#d6a100', '#30a46c', '#0091ff', '#6e56cf', '#d6409f', '#12a594'];

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* modo privado / cuota */
  }
}

export interface Identity {
  clientId: string;
  name: string;
  color: string;
}

/**
 * Nombre y color: por navegador (localStorage). clientId: POR PESTAÑA (sessionStorage).
 * El clientId es el `node` del reloj HLC: dos pestañas con el mismo node podrían emitir timestamps
 * idénticos para operaciones distintas y el LWW descartaría una en silencio.
 */
export function getIdentity(): Identity {
  let prefs = read<{ name: string; color: string }>('collab.prefs');
  if (!prefs) {
    prefs = { name: `Guest ${Math.floor(Math.random() * 900 + 100)}`, color: COLORS[Math.floor(Math.random() * COLORS.length)]! };
    write('collab.prefs', prefs);
  }
  let clientId: string | null = null;
  try {
    clientId = sessionStorage.getItem('collab.clientId');
  } catch {}
  if (!clientId) {
    const rand = crypto.getRandomValues(new Uint8Array(8));
    clientId = 'c' + Array.from(rand, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
    try {
      sessionStorage.setItem('collab.clientId', clientId);
    } catch {}
  }
  return { clientId, ...prefs };
}

export function setName(name: string): Identity {
  const cur = getIdentity();
  write('collab.prefs', { name: name.trim().slice(0, 30) || 'Guest', color: cur.color });
  return getIdentity();
}

export interface RecentBoard {
  id: string;
  title: string;
  at: number;
}
export const recentBoards = (): RecentBoard[] => read<RecentBoard[]>('collab.recent') ?? [];
export function rememberBoard(id: string, title: string) {
  const list = recentBoards().filter((b) => b.id !== id);
  write('collab.recent', [{ id, title, at: Date.now() }, ...list].slice(0, 12));
}
