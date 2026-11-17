export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const KEY = 'tenantly.session';
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
}

export const session = {
  get(): StoredSession | null {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  set(s: StoredSession | null) {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  },
};

let tenantId: string | null = null;
export const setActiveTenant = (id: string | null) => {
  tenantId = id;
};

let refreshing: Promise<boolean> | null = null;
/** Una sola renovación a la vez aunque varias peticiones fallen con 401 simultáneamente. */
function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const s = session.get();
    if (!s) return false;
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    });
    if (!res.ok) {
      session.set(null);
      return false;
    }
    session.set(await res.json());
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T = any>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const s = session.get();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(s ? { authorization: `Bearer ${s.accessToken}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry && s && !path.startsWith('/auth/') && (await refresh())) {
    return api<T>(method, path, body, false);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? res.statusText, e.details);
  }
  return data as T;
}
