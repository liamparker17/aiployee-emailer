import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  created_at?: string;
}

export function useTenants() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ tenants: TenantSummary[] }>('/api/admin/tenants');
      setTenants(r.tenants);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { tenants, loading, reload };
}
