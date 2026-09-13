import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Icon, BRAND_MARK_SRC } from '../core/icons';
import { useAuth } from '../core/auth';
import { useUpdateCheck } from '../hooks/useUpdateCheck';
import { useT } from '../i18n';
import type { Messages } from '../i18n/en';

interface NavEntry {
  path: string;
  label: (t: Messages) => string;
  iconName: string;
  adminOnly?: boolean;
}

const NAV: NavEntry[] = [
  { path: '/', label: (t) => t.common.nav.overview, iconName: 'dashboard' },
  { path: '/agents', label: (t) => t.common.nav.agents, iconName: 'agent', adminOnly: true },
  { path: '/targets', label: (t) => t.common.nav.targets, iconName: 'target' },
  { path: '/jobs', label: (t) => t.common.nav.jobs, iconName: 'job' },
  { path: '/snapshots', label: (t) => t.common.nav.snapshots, iconName: 'snapshot' },
  { path: '/notifications', label: (t) => t.common.nav.notifications, iconName: 'bell', adminOnly: true },
  { path: '/reports', label: (t) => t.common.nav.reports, iconName: 'chart', adminOnly: true },
  { path: '/users', label: (t) => t.common.nav.users, iconName: 'users', adminOnly: true },
  { path: '/admin', label: (t) => t.common.nav.admin, iconName: 'shield', adminOnly: true },
  { path: '/audit', label: (t) => t.common.nav.audit, iconName: 'clock', adminOnly: true },
  { path: '/settings', label: (t) => t.common.nav.settings, iconName: 'settings' },
];

function BrandMark() {
  return <img className="brand-mark" src={BRAND_MARK_SRC} width={28} height={28} alt="" />;
}

function BrandName() {
  return (
    <div className="brand-name">
      Amber<span>Backup</span>
    </div>
  );
}

export function Shell() {
  const { user, isAdmin, logout } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const update = useUpdateCheck();
  const t = useT();
  const closeNav = () => setNavOpen(false);

  const navItems = NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => (
    <NavLink
      key={n.path}
      to={n.path}
      end={n.path === '/'}
      className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
      onClick={closeNav}
    >
      <Icon name={n.iconName} />
      {n.label(t)}
    </NavLink>
  ));

  return (
    <div className={'app' + (navOpen ? ' nav-open' : '')}>
      <header className="mobile-topbar">
        <button
          className="btn-icon hamburger"
          aria-label={t.common.nav.toggleNavigation}
          onClick={() => setNavOpen((o) => !o)}
        >
          <Icon name="menu" />
        </button>
        <div className="brand">
          <BrandMark />
          <BrandName />
        </div>
      </header>

      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <BrandName />
        </div>
        {navItems}
        <div className="sidebar-footer">
          <div className="nav-label">{t.common.nav.signedInAs}</div>
          <div className="user-switch">
            <span className="user-dot" />
            <div className="user-meta">
              <div className="user-name">{user?.display_name ?? ''}</div>
              <div className="user-sub">{isAdmin ? t.common.administrator : t.common.user}</div>
            </div>
            <button
              className="btn-icon"
              title={t.common.nav.signOut}
              onClick={() => {
                void logout();
              }}
            >
              <Icon name="logout" />
            </button>
          </div>
          <div className="app-version">
            {`v${__APP_VERSION__}`}
            {update && (
              <a
                className="app-update"
                href={update.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={t.common.nav.versionAvailable(update.version)}
                aria-label={t.common.nav.versionAvailable(update.version)}
              >
                <Icon name="upgrade" />
              </a>
            )}
          </div>
        </div>
      </aside>

      <div className="nav-backdrop" onClick={closeNav} />

      <main className="main" id="outlet">
        <Outlet />
      </main>
    </div>
  );
}
