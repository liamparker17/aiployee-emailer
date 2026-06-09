import { api } from '../api';

export interface ValuesField { key: string; label: string; required: boolean; type?: string }
export interface CallAgent { id: string; label: string; values_schema: ValuesField[]; default_timezone: string; active: boolean; hasKey: true }
export type RecipientStatus = 'pending' | 'queued' | 'launched' | 'failed' | 'suppressed' | 'completed' | 'canceled';
export type CampaignStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'canceled';
export interface CampaignCounts { pending: number; queued: number; launched: number; failed: number; suppressed: number; completed: number; canceled: number }
export interface CallCampaign {
  id: string; agent_id: string; name: string; audience_type: 'list' | 'segment' | 'csv';
  audience_id: string | null; status: CampaignStatus; recipient_count: number; counts: CampaignCounts;
  scheduled_for: string | null; created_at: string;
}
export interface Recipient {
  id: string; suid: string; name: string; phone: string; values: Record<string, unknown>;
  status: RecipientStatus; attempts: number; last_error: string | null; outcome: string | null;
  result_message_id: string | null;
}

export const listAgents = () => api<{ agents: CallAgent[] }>('/api/calls/agents');
export const createAgent = (body: { label: string; company_key: string; values_schema: ValuesField[]; default_timezone?: string }) =>
  api<{ agent: CallAgent }>('/api/calls/agents', { method: 'POST', body: JSON.stringify(body) });
export const updateAgent = (id: string, patch: Partial<{ label: string; company_key: string; values_schema: ValuesField[]; default_timezone: string; active: boolean }>) =>
  api<{ agent: CallAgent }>(`/api/calls/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const listCampaigns = () => api<{ campaigns: CallCampaign[] }>('/api/calls/campaigns');
export const getCampaign = (id: string) => api<{ campaign: CallCampaign }>(`/api/calls/campaigns/${id}`);
export const createCampaign = (body: { agent_id: string; name: string; audience_type: 'list' | 'segment' | 'csv'; audience_id?: string; scheduled_for?: string }) =>
  api<{ campaign: CallCampaign }>('/api/calls/campaigns', { method: 'POST', body: JSON.stringify(body) });
export const addCsvRecipients = (id: string, rows: Record<string, string>[]) =>
  api<{ added: number; errors: string[] }>(`/api/calls/campaigns/${id}/recipients`, { method: 'POST', body: JSON.stringify({ source: 'csv', rows }) });
export const addAudienceRecipients = (id: string) =>
  api<{ added: number; errors: string[] }>(`/api/calls/campaigns/${id}/recipients`, { method: 'POST', body: JSON.stringify({ source: 'audience' }) });
export const listRecipients = (id: string, status?: RecipientStatus) =>
  api<{ recipients: Recipient[]; total: number }>(`/api/calls/campaigns/${id}/recipients${status ? `?status=${status}` : ''}`);
export const approveCampaign = (id: string) => api<{ campaign: CallCampaign }>(`/api/calls/campaigns/${id}/approve`, { method: 'POST' });
export const pauseCampaign = (id: string) => api<{ campaign: CallCampaign }>(`/api/calls/campaigns/${id}/pause`, { method: 'POST' });
export const resumeCampaign = (id: string) => api<{ campaign: CallCampaign }>(`/api/calls/campaigns/${id}/resume`, { method: 'POST' });
export const cancelCampaign = (id: string) => api<{ campaign: CallCampaign }>(`/api/calls/campaigns/${id}/cancel`, { method: 'POST' });
