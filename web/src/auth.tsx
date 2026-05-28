import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface SessionUser { id: string; email: string; role: 'super_admin' | 'tenant_admin' | 'tenant_user'; tenantId: string | null; activeTenantId: string | null }

interface AuthCtx {
  user: SessionUser | null;
  loading: boolean;
  login: (e: string, p: string) => Promise<void>;
  logout: () => Promise<void>;
  setActiveTenant: (tenantId: string) => Promise<void>;
  clearActiveTenant: () => Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const me = await api<{ user: SessionUser | null }>('/api/me');
        if (!me.user) { setUser(null); return; }
        const at = await api<{ tenantId: string | null }>('/api/session/active-tenant');
        setUser({ ...me.user, activeTenantId: at.tenantId });
      } catch { setUser(null); }
      finally { setLoading(false); }
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ user: SessionUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const setActiveTenant = useCallback(async (tenantId: string) => {
    await api('/api/session/active-tenant', { method: 'POST', body: JSON.stringify({ tenantId }) });
    setUser(u => u ? { ...u, activeTenantId: tenantId } : u);
  }, []);

  const clearActiveTenant = useCallback(async () => {
    await api('/api/session/active-tenant', { method: 'DELETE' });
    setUser(u => u ? { ...u, activeTenantId: null } : u);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, logout, setActiveTenant, clearActiveTenant }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
