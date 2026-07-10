// Minimal hash-based router.

export interface Route {
  path: string;
  render: (params: Record<string, string>) => Node | Promise<Node>;
}

type Listener = (path: string) => void;

class Router {
  private routes: Route[] = [];
  private listeners: Listener[] = [];

  register(routes: Route[]): void {
    this.routes = routes;
  }

  onNavigate(fn: Listener): void {
    this.listeners.push(fn);
  }

  current(): string {
    return location.hash.slice(1) || '/';
  }

  navigate(path: string): void {
    if (this.current() === path) this.resolve();
    else location.hash = path;
  }

  start(): void {
    window.addEventListener('hashchange', () => this.resolve());
    this.resolve();
  }

  private match(path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      const params = this.matchPath(route.path, path);
      if (params) return { route, params };
    }
    return null;
  }

  private matchPath(
    pattern: string,
    path: string,
  ): Record<string, string> | null {
    const pp = pattern.split('/').filter(Boolean);
    const ap = path.split('/').filter(Boolean);
    if (pp.length !== ap.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (pp[i] !== ap[i]) return null;
    }
    return params;
  }

  async resolve(): Promise<void> {
    const path = this.current();
    this.listeners.forEach((fn) => fn(path));
    const outlet = document.getElementById('outlet');
    if (!outlet) return;
    const matched = this.match(path) ?? this.match('/');
    if (!matched) return;
    outlet.replaceChildren();
    const node = await matched.route.render(matched.params);
    outlet.replaceChildren(node);
  }
}

export const router = new Router();
