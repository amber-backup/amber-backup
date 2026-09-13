import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './core/auth';
import { ToastProvider } from './ui/toast';
import { ModalProvider } from './ui/modal';
import { Loading } from './ui/primitives';
import { Shell } from './layout/Shell';
import { Login } from './pages/login';
import { Dashboard } from './pages/dashboard';
import { Targets } from './pages/targets';
import { Jobs } from './pages/jobs';
import { Agents } from './pages/agents';
import { Snapshots } from './pages/snapshots';
import { Users } from './pages/users';
import { Notifications } from './pages/notifications';
import { Reports } from './pages/reports';
import { Admin } from './pages/admin';
import { AuditLog } from './pages/audit';
import { Settings } from './pages/settings';

/** Forwards the former `/restore/:jobId` URL to the Snapshots page. */
function RestoreRedirect() {
  const { jobId } = useParams();
  return <Navigate to={`/snapshots/${encodeURIComponent(jobId ?? '')}`} replace />;
}

function Gate() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loading />
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/targets" element={<Targets />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/snapshots" element={<Snapshots />} />
        <Route path="/snapshots/:jobId" element={<Snapshots />} />
        {/* The page was called Restore; keep old bookmarks and links working. */}
        <Route path="/restore" element={<Navigate to="/snapshots" replace />} />
        <Route path="/restore/:jobId" element={<RestoreRedirect />} />
        <Route path="/users" element={<Users />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/audit" element={<AuditLog />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ModalProvider>
          <HashRouter>
            <Gate />
          </HashRouter>
        </ModalProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
