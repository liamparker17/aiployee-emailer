import { api } from '@aiployee/ui';

export const testSendTemplate = (id: string, payload: { to: string; variables?: Record<string, string> }) =>
  api<{ ok: boolean; messageId?: string; error?: string }>(`/api/templates/${id}/test-send`, {
    method: 'POST', body: JSON.stringify(payload),
  });
