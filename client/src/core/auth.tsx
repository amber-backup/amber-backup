import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type User } from './api';
import { authenticatePasskey } from './passkeys';

/** Login either signs in, or reports that a TOTP second factor is required. */
export type LoginResult =
  | { user: User }
  | { totpRequired: true; challengeToken: string };

interface AuthContextValue {
  user: User | null;
  isAdmin: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  loginTotp: (challengeToken: string, code: string) => Promise<void>;
  loginPasskey: () => Promise<void>;
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

  const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
    const res = await api.post<LoginResult>('/auth/login', { email, password });
    if ('user' in res) setUser(res.user);
    return res;
  }, []);

  const loginTotp = useCallback(
    async (challengeToken: string, code: string): Promise<void> => {
      const res = await api.post<{ user: User }>('/auth/login/totp', {
        challengeToken,
        code,
      });
      setUser(res.user);
    },
    [],
  );

  const loginPasskey = useCallback(async (): Promise<void> => {
    setUser(await authenticatePasskey());
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    await api.post('/auth/logout');
    setUser(null);
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAdmin: user?.is_admin ?? false,
      loading,
      login,
      loginTotp,
      loginPasskey,
      logout,
      refresh,
    }),
    [user, loading, login, loginTotp, loginPasskey, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
