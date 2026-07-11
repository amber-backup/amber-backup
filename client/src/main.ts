import './styles.css';
import { auth } from './core/auth';
import { router } from './core/router';
import { renderShell } from './core/layout';
import { renderLogin } from './pages/login';
import { renderDashboard } from './pages/dashboard';
import { renderTargets } from './pages/targets';
import { renderJobs } from './pages/jobs';
import { renderAgents } from './pages/agents';
import { renderRestore } from './pages/restore';
import { renderUsers } from './pages/users';
import { renderNotifications } from './pages/notifications';
import { renderAdmin } from './pages/admin';
import { renderAuditLog } from './pages/audit';
import { renderSettings } from './pages/settings';

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  await auth.refresh();

  if (!auth.user) {
    app.replaceChildren(renderLogin());
    return;
  }

  router.register([
    { path: '/', render: renderDashboard },
    { path: '/targets', render: renderTargets },
    { path: '/jobs', render: renderJobs },
    { path: '/agents', render: renderAgents },
    { path: '/restore', render: renderRestore },
    { path: '/restore/:targetId', render: renderRestore },
    { path: '/users', render: renderUsers },
    { path: '/notifications', render: renderNotifications },
    { path: '/admin', render: renderAdmin },
    { path: '/audit', render: renderAuditLog },
    { path: '/settings', render: renderSettings },
  ]);

  app.replaceChildren(renderShell());
  if (location.hash === '#/login' || !location.hash) location.hash = '/';
  router.start();
}

void boot();
