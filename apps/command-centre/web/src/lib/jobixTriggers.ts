import { api } from '@aiployee/ui';

export type TokenPlacement = 'bearer' | 'header' | 'query' | 'body';
export interface JobixTrigger {
  id: string; label: string; url: string; token_placement: TokenPlacement; token_param: string | null;
  payload_template: string; active: boolean; last_fired_at: string | null; hasToken: true;
}
export interface FireResult {
  ok: boolean; httpStatus: number | null; responseSnippet: string | null;
  error: string | null; renderedPayload: string; unresolved: string[];
}
export interface FireRow {
  id: string; source: string; vars: Record<string, unknown>; http_status: number | null;
  ok: boolean; response_snippet: string | null; error: string | null; created_at: string;
}

export const listTriggers = () => api<{ triggers: JobixTrigger[] }>('/api/jobix-triggers');
export const createTrigger = (body: { label: string; url?: string; token: string; token_placement?: TokenPlacement; token_param?: string; payload_template: string }) =>
  api<{ trigger: JobixTrigger }>('/api/jobix-triggers', { method: 'POST', body: JSON.stringify(body) });
export const updateTrigger = (id: string, patch: Partial<{ label: string; url: string; token: string; token_placement: TokenPlacement; token_param: string | null; payload_template: string; active: boolean }>) =>
  api<{ trigger: JobixTrigger }>(`/api/jobix-triggers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteTrigger = (id: string) =>
  api<{ ok: boolean }>(`/api/jobix-triggers/${id}`, { method: 'DELETE' });
export const testTrigger = (id: string, vars: Record<string, string>) =>
  api<{ result: FireResult }>(`/api/jobix-triggers/${id}/test`, { method: 'POST', body: JSON.stringify({ vars }) });
export const fireTrigger = (id: string, vars: Record<string, string>) =>
  api<{ result: FireResult }>(`/api/jobix-triggers/${id}/fire`, { method: 'POST', body: JSON.stringify({ vars }) });
export const listFires = (id: string) =>
  api<{ fires: FireRow[]; total: number }>(`/api/jobix-triggers/${id}/fires`);
