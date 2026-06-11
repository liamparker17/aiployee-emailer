import { api } from '@aiployee/ui';

export interface WaConnection {
  id: string; tenant_id: string; base_url: string; from_number: string | null;
  active: boolean; last_ok_at: string | null; last_error: string | null; hasKey: true;
  created_at: string; updated_at: string;
}

export interface WaConnectionInput {
  base_url: string; api_key?: string; from_number?: string | null; active?: boolean;
}

export interface WaTestResult { ok: boolean; status: number | null; error: string | null; response: unknown }

export const getConnection = () => api<{ connection: WaConnection | null }>('/api/whatsapp/connection');
export const saveConnection = (input: WaConnectionInput) =>
  api<{ connection: WaConnection }>('/api/whatsapp/connection', { method: 'PUT', body: JSON.stringify(input) });
export const deleteConnection = () => api<{ ok: true }>('/api/whatsapp/connection', { method: 'DELETE' });
export const testSend = (to: string, message?: string) =>
  api<WaTestResult>('/api/whatsapp/test', { method: 'POST', body: JSON.stringify({ to, ...(message ? { message } : {}) }) });
