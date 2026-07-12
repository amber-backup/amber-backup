import { h } from './dom';
import { icon, BRAND_MARK_SRC, ICONS } from './icons';
import { auth } from './auth';
import { router } from './router';

interface NavEntry {
  path: string;
  label: string;
  iconName: string;
  adminOnly?: boolean;
}

const NAV: NavEntry[] = [
  { path: '/', label: 'Overview', iconName: 'dashboard' },
  { path: '/agents', label: 'Agents', iconName: 'agent', adminOnly: true },
  { path: '/targets', label: 'Targets', iconName: 'target' },
  { path: '/jobs', label: 'Jobs', iconName: 'job' },
  { path: '/restore', label: 'Restore', iconName: 'restore' },
  { path: '/notifications', label: 'Notifications', iconName: 'bell', adminOnly: true },
  { path: '/reports', label: 'Reports', iconName: 'chart', adminOnly: true },
  { path: '/users', label: 'Users', iconName: 'users', adminOnly: true },
  { path: '/admin', label: 'Admin', iconName: 'shield', adminOnly: true },
  { path: '/audit', label: 'Audit Log', iconName: 'clock', adminOnly: true },
  { path: '/settings', label: 'Settings', iconName: 'settings' },
];

/** Builds the persistent app shell; page content mounts into #outlet. */
const brandMark = (): HTMLElement =>
  h('img', {
    class: 'brand-mark',
    src: BRAND_MARK_SRC,
    width: 28,
    height: 28,
    alt: '',
  });

export function renderShell(): HTMLElement {
  const navItems = NAV.filter((n) => !n.adminOnly || auth.isAdmin).map((n) =>
    h(
      'a',
      { class: 'nav-item', href: `#${n.path}`, 'data-path': n.path },
      icon(n.iconName),
      n.label,
    ),
  );

  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'brand' },
      brandMark(),
      h('div', { class: 'brand-name', html: 'Amber<span>Backup</span>' }),
    ),
    ...navItems,
    h(
      'div',
      { class: 'sidebar-footer' },
      h('div', { class: 'nav-label' }, 'Signed in as'),
      h(
        'div',
        { class: 'user-switch' },
        h('span', { class: 'user-dot' }),
        h(
          'div',
          { class: 'user-meta' },
          h('div', { class: 'user-name' }, auth.user?.display_name ?? ''),
          h(
            'div',
            { class: 'user-sub' },
            auth.isAdmin ? 'Administrator' : 'User',
          ),
        ),
        h(
          'button',
          {
            class: 'btn-icon',
            title: 'Sign out',
            onclick: async () => {
              await auth.logout();
              location.hash = '/login';
              location.reload();
            },
          },
          icon('logout'),
        ),
      ),
      h('div', { class: 'app-version' }, `v${__APP_VERSION__}`),
    ),
  );

  const shell = h('div', { class: 'app' });

  const closeNav = () => shell.classList.remove('nav-open');

  // Mobile-only top bar with a hamburger that toggles the sidebar drawer.
  const mobileTopbar = h(
    'header',
    { class: 'mobile-topbar' },
    h(
      'button',
      {
        class: 'btn-icon hamburger',
        'aria-label': 'Toggle navigation',
        onclick: () => shell.classList.toggle('nav-open'),
      },
      icon('menu'),
    ),
    h(
      'div',
      { class: 'brand' },
      brandMark(),
      h('div', { class: 'brand-name', html: 'Amber<span>Backup</span>' }),
    ),
  );

  const backdrop = h('div', { class: 'nav-backdrop', onclick: closeNav });

  // Close the drawer whenever a nav link is followed.
  sidebar.querySelectorAll('.nav-item').forEach((el) =>
    el.addEventListener('click', closeNav),
  );

  shell.append(
    mobileTopbar,
    sidebar,
    backdrop,
    h('main', { class: 'main', id: 'outlet' }),
  );

  // Highlight the active nav entry on navigation, and close the mobile drawer.
  router.onNavigate((path) => {
    closeNav();
    shell.querySelectorAll('.nav-item').forEach((el) => {
      const p = (el as HTMLElement).dataset.path!;
      el.classList.toggle(
        'active',
        p === '/' ? path === '/' : path.startsWith(p),
      );
    });
  });

  return shell;
}

/** Standard page header with title, subtitle, and action buttons. */
export function pageHeader(
  title: string,
  subtitle: string,
  actions: HTMLElement[] = [],
): HTMLElement {
  return h(
    'div',
    { class: 'topbar' },
    h(
      'div',
      { class: 'page-title' },
      h('h1', {}, title),
      h('p', {}, subtitle),
    ),
    h('div', { class: 'topbar-actions' }, ...actions),
  );
}

export function actionButton(
  label: string,
  iconName: string,
  onClick: () => void,
  variant: 'primary' | 'ghost' = 'ghost',
): HTMLElement {
  const btn = h(
    'button',
    { class: `btn btn-${variant}`, onclick: onClick },
    icon(iconName),
    h('span', {}, label),
  );
  return btn;
}

export { ICONS };
