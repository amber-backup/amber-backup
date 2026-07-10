import { api, User } from './api';

class AuthStore {
  user: User | null = null;

  async refresh(): Promise<User | null> {
    try {
      this.user = await api.get<User>('/auth/me');
    } catch {
      this.user = null;
    }
    return this.user;
  }

  async login(email: string, password: string): Promise<void> {
    const res = await api.post<{ user: User }>('/auth/login', {
      email,
      password,
    });
    this.user = res.user;
  }

  async logout(): Promise<void> {
    await api.post('/auth/logout');
    this.user = null;
  }

  get isAdmin(): boolean {
    return this.user?.is_admin ?? false;
  }
}

export const auth = new AuthStore();
