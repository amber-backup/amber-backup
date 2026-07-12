import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type User } from './api';

interface AuthContextValue {
  user: User | null;
  isAdmin: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<User | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<User | null> => {
    try {
      const me = await api.get<User>('/auth/me');
      setUser(me);
      return me;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const res = await api.post<{ user: User }>('/auth/login', { email, password });
    setUser(res.user);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    await api.post('/auth/logout');
    setUser(null);
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, isAdmin: user?.is_admin ?? false, loading, login, logout, refresh }),
    [user, loading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
