import { createBrowserRouter, Navigate, useParams, useLocation } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';
import Dashboard from './pages/Dashboard';
import Senders from './pages/Senders';
import Templates from './pages/Templates';
import SmtpConfigs from './pages/SmtpConfigs';
import ApiKeys from './pages/ApiKeys';
import EmailLog from './pages/EmailLog';
import Suppressions from './pages/Suppressions';
import Users from './pages/Users';
import AdminTenants from './pages/AdminTenants';
import TenantPicker from './pages/TenantPicker';
import Onboarding from './pages/Onboarding';
import JobixBuilder from './pages/JobixBuilder';
import AiResponses from './pages/AiResponses';

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
  { path: '/onboarding', element: <AuthProvider><Authed><Onboarding /></Authed></AuthProvider> },
  { path: '/admin/tenants', element: <AuthProvider><Authed><AdminTenants /></Authed></AuthProvider> },

  {
    path: '/t/:tenantId',
    element: <AuthProvider><Authed><TenantGate><AppShell /></TenantGate></Authed></AuthProvider>,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'senders', element: <Senders /> },
      { path: 'templates', element: <Templates /> },
      { path: 'smtp', element: <SmtpConfigs /> },
      { path: 'api-keys', element: <ApiKeys /> },
      { path: 'jobix-builder', element: <JobixBuilder /> },
      { path: 'ai-responses', element: <AiResponses /> },
      { path: 'log', element: <EmailLog /> },
      { path: 'suppressions', element: <Suppressions /> },
      { path: 'users', element: <Users /> },
    ],
  },

  // Legacy paths: /senders, /templates, etc. → /t/:lastUsedTenantId/<segment>
  { path: '/senders', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/templates', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/smtp', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/api-keys', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/log', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/suppressions', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/users', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
]);
