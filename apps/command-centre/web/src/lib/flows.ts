import { api } from '@aiployee/ui';

export type FlowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type StepKind = 'wait' | 'jobix_call' | 'condition' | 'whatsapp_send';
export type EnrollmentStatus = 'active' | 'completed' | 'exited' | 'failed';

export interface Flow { id: string; name: string; status: FlowStatus; created_at: string }
export interface FlowWithCounts extends Flow {
  step_count: number; total_enrollments: number; active_enrollments: number; completed_enrollments: number;
}
export interface FlowStep { id: string; position: number; kind: StepKind; config: Record<string, unknown> }
export interface FlowCounts { active: number; completed: number; exited: number; failed: number }
export interface Enrollment {
  id: string; name: string; phone: string; email: string; status: EnrollmentStatus;
  current_position: number; next_run_at: string | null; last_error: string | null; created_at: string;
}
export interface StepInput { kind: StepKind; config: Record<string, unknown> }
export interface Recipient { name: string; phone: string; email?: string; context?: Record<string, unknown> }

export const listFlows = () => api<{ flows: FlowWithCounts[] }>('/api/flows');
export const createFlow = (name: string) =>
  api<{ flow: Flow }>('/api/flows', { method: 'POST', body: JSON.stringify({ name }) });
export const getFlow = (id: string) =>
  api<{ flow: Flow; steps: FlowStep[]; counts: FlowCounts }>(`/api/flows/${id}`);
export const renameFlow = (id: string, name: string) =>
  api<{ flow: Flow }>(`/api/flows/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
export const saveSteps = (id: string, steps: StepInput[]) =>
  api<{ steps: FlowStep[] }>(`/api/flows/${id}/steps`, { method: 'PUT', body: JSON.stringify({ steps }) });
export const activateFlow = (id: string) => api<{ flow: Flow }>(`/api/flows/${id}/activate`, { method: 'POST' });
export const pauseFlow = (id: string) => api<{ flow: Flow }>(`/api/flows/${id}/pause`, { method: 'POST' });
export const archiveFlow = (id: string) => api<{ flow: Flow }>(`/api/flows/${id}/archive`, { method: 'POST' });
export const enrollFlow = (id: string, recipients: Recipient[]) =>
  api<{ added: number; errors: string[] }>(`/api/flows/${id}/enroll`, { method: 'POST', body: JSON.stringify({ recipients }) });
export const listEnrollments = (id: string, status?: EnrollmentStatus) =>
  api<{ enrollments: Enrollment[]; total: number }>(`/api/flows/${id}/enrollments${status ? `?status=${status}` : ''}`);
