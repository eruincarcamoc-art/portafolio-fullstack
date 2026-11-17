import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, session, setActiveTenant } from './api';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: 'free' | 'pro' | 'business';
  role: Role;
}
export interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  loading: boolean;
  user: User | null;
  workspaces: Workspace[];
  active: Workspace | null;
  selectWorkspace(id: string): void;
  login(email: string, password: string): Promise<void>;
  register(input: { email: string; password: string; name: string; workspaceName: string }): Promise<void>;
  logout(): Promise<void>;
  reload(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
const ACTIVE_KEY = 'tenantly.active';

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(localStorage.getItem(ACTIVE_KEY));

  const active = useMemo(() => workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? null, [workspaces, activeId]);
  setActiveTenant(active?.id ?? null);

  const reload = useCallback(async () => {
    if (!session.get()) {
      setUser(null);
      setWorkspaces([]);
      return;
    }
    try {
      const me = await api<{ user: User; tenants: Workspace[] }>('GET', '/me');
      setUser(me.user);
      setWorkspaces(me.tenants);
    } catch {
      session.set(null);
      setUser(null);
      setWorkspaces([]);
    }
  }, []);

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, [reload]);

  const value: AuthState = {
    loading,
    user,
    workspaces,
    active,
    selectWorkspace(id) {
      localStorage.setItem(ACTIVE_KEY, id);
      setActiveId(id);
      qc.clear(); // nunca mezclar cachés entre workspaces
    },
    async login(email, password) {
      const r = await api('POST', '/auth/login', { email, password });
      session.set({ accessToken: r.accessToken, refreshToken: r.refreshToken });
      await reload();
    },
    async register(input) {
      const r = await api('POST', '/auth/register', input);
      session.set({ accessToken: r.accessToken, refreshToken: r.refreshToken });
      localStorage.setItem(ACTIVE_KEY, r.tenant.id);
      setActiveId(r.tenant.id);
      await reload();
    },
    async logout() {
      const s = session.get();
      if (s) await api('POST', '/auth/logout', { refreshToken: s.refreshToken }).catch(() => {});
      session.set(null);
      setUser(null);
      setWorkspaces([]);
      qc.clear();
    },
    reload,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const atLeast = (role: Role | undefined, min: Role) => (role ? RANK[role] >= RANK[min] : false);
