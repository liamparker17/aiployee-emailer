import { createBrowserRouter, Navigate } from 'react-router-dom';
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
import type { ReactNode } from 'react';

function Authed({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export const router = createBrowserRouter([
  { path: '/login', element: <AuthProvider><Login /></AuthProvider> },
  { path: '/accept-invite', element: <AuthProvider><AcceptInvite /></AuthProvider> },
  {
    path: '/', element: <AuthProvider><Authed><AppShell /></Authed></AuthProvider>,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'senders', element: <Senders /> },
      { path: 'templates', element: <Templates /> },
      { path: 'smtp', element: <SmtpConfigs /> },
      { path: 'api-keys', element: <ApiKeys /> },
      { path: 'log', element: <EmailLog /> },
      { path: 'suppressions', element: <Suppressions /> },
      { path: 'users', element: <Users /> },
      { path: 'admin/tenants', element: <AdminTenants /> },
    ],
  },
]);
