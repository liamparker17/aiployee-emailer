import { createBrowserRouter, Navigate, useParams, useLocation } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from '@aiployee/ui';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';
import TenantPicker from './pages/TenantPicker';
import Dashboard from './pages/Dashboard';
import Abe from './pages/Abe';
import Calls from './pages/Calls';
import CallCampaigns from './pages/CallCampaigns';
import Flows from './pages/Flows';
import JobixBuilder from './pages/JobixBuilder';
import WhatsApp from './pages/WhatsApp';

function Authed({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function TenantGate({ children }: { children: ReactNode }) {
  const { tenantId } = useParams<{ tenantId: string }>();
  const { user, setActiveTenant } = useAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!tenantId) return;
    if (user?.activeTenantId === tenantId) { setReady(true); return; }
    setReady(false);
    setActiveTenant(tenantId).then(() => setReady(true)).catch(() => setReady(true));
  }, [tenantId, user?.activeTenantId, setActiveTenant]);
  if (!ready) return null;
  return <>{children}</>;
}

function LegacyRedirect() {
  const { user } = useAuth();
  const loc = useLocation();
  const fallback = localStorage.getItem('lastTenantId') ?? user?.tenantId ?? user?.activeTenantId ?? null;
  if (fallback) return <Navigate to={`/t/${fallback}${loc.pathname}${loc.search}`} replace />;
  return <Navigate to="/" replace />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <AuthProvider><Login /></AuthProvider> },
  { path: '/accept-invite', element: <AuthProvider><AcceptInvite /></AuthProvider> },

  { path: '/', element: <AuthProvider><Authed><TenantPicker /></Authed></AuthProvider> },

  {
    path: '/t/:tenantId',
    element: <AuthProvider><Authed><TenantGate><AppShell /></TenantGate></Authed></AuthProvider>,
    children: [
      { index: true, element: <Navigate to="abe" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'abe', element: <Abe /> },
      { path: 'calls', element: <Calls /> },
      { path: 'outbound-calls', element: <CallCampaigns /> },
      { path: 'flows', element: <Flows /> },
      { path: 'jobix-builder', element: <JobixBuilder /> },
      { path: 'whatsapp', element: <WhatsApp /> },
    ],
  },

  // Legacy path redirects
  { path: '/abe', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/calls', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/flows', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
]);
