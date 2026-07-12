import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Icon, BRAND_MARK_SRC } from '../core/icons';
import { useAuth } from '../core/auth';

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
      {n.label}
    </NavLink>
  ));

  return (
    <div className={'app' + (navOpen ? ' nav-open' : '')}>
      <header className="mobile-topbar">
        <button
          className="btn-icon hamburger"
          aria-label="Toggle navigation"
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
          <div className="nav-label">Signed in as</div>
          <div className="user-switch">
            <span className="user-dot" />
            <div className="user-meta">
              <div className="user-name">{user?.display_name ?? ''}</div>
              <div className="user-sub">{isAdmin ? 'Administrator' : 'User'}</div>
            </div>
            <button
              className="btn-icon"
              title="Sign out"
              onClick={() => {
                void logout();
              }}
            >
              <Icon name="logout" />
            </button>
          </div>
          <div className="app-version">{`v${__APP_VERSION__}`}</div>
        </div>
      </aside>

      <div className="nav-backdrop" onClick={closeNav} />

      <main className="main" id="outlet">
        <Outlet />
      </main>
    </div>
  );
}
