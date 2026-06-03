import { api } from '../api';

export interface Call {
  id: string;
  created_at: string;
  content: string;
  category: string | null;
  severity: string | null;
}

export interface Breakdown {
  window: string;
  total: number;
  byCategory: Array<{ category: string; count: number }>;
  perDay: Array<{ day: string; count: number }>;
}

export const listCalls = (
  q: {
    category?: string;
    search?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
) => {
  const p = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== '') p.set(k, String(v));
  });
  const qs = p.toString();
  return api<{ calls: Call[]; total: number }>(`/api/calls${qs ? `?${qs}` : ''}`);
};

export const getCall = (id: string) => api<{ call: Call }>(`/api/calls/${id}`);

export const getBreakdown = (window: string) =>
  api<Breakdown>(`/api/calls/breakdown?window=${window}`);

export const getCategories = () => api<{ categories: string[] }>(`/api/calls/categories`);

export const putCategories = (categories: string[]) =>
  api<{ categories: string[] }>(`/api/calls/categories`, {
    method: 'PUT',
    body: JSON.stringify({ categories }),
  });

export const suggestCategories = () =>
  api<{ suggested: string[] }>(`/api/calls/suggest-categories`, { method: 'POST' });

export const retagCalls = () =>
  api<{ retagged: number; remaining: number }>(`/api/calls/retag`, { method: 'POST' });

export const getCallSettings = () =>
  api<{ ingestSendsAsCalls: boolean }>(`/api/calls/settings`);

export const putCallSettings = (ingestSendsAsCalls: boolean) =>
  api<{ ingestSendsAsCalls: boolean }>(`/api/calls/settings`, {
    method: 'PUT',
    body: JSON.stringify({ ingestSendsAsCalls }),
  });

export const importPastCalls = () =>
  api<{ imported: number; tagged: number }>(`/api/calls/import-past`, { method: 'POST' });
