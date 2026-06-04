import { api } from '../api';

export const testSendTemplate = (id: string, payload: { to: string; variables?: Record<string, string> }) =>
  api<{ ok: boolean; messageId?: string; error?: string }>(`/api/templates/${id}/test-send`, {
    method: 'POST', body: JSON.stringify(payload),
  });
