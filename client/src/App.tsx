import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
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
import { Restore } from './pages/restore';
import { Users } from './pages/users';
import { Notifications } from './pages/notifications';
import { Reports } from './pages/reports';
import { Admin } from './pages/admin';
import { AuditLog } from './pages/audit';
import { Settings } from './pages/settings';

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
        <Route path="/restore" element={<Restore />} />
        <Route path="/restore/:jobId" element={<Restore />} />
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
