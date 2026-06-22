export type ThreadStage =
  | 'new_reply'
  | 'needs_triage'
  | 'needs_human_reply'
  | 'draft_ready'
  | 'awaiting_customer'
  | 'follow_up_due'
  | 'escalated'
  | 'converted'
  | 'lost'
  | 'closed'
  | 'unsubscribed';

export interface Thread {
  id: string;
  contact_id: string | null;
  campaign_id: string | null;
  stage: ThreadStage;
  intent: string | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  urgency: 'low' | 'medium' | 'high' | null;
  lead_score: number | null;
  objection_type: string | null;
  commercial_value: 'low' | 'medium' | 'high' | null;
  owner_user_id: string | null;
  next_action: string | null;
  next_action_due_at: string | null;
  status: 'open' | 'closed';
  confidence: number | null;
  last_agent_analysis_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ActionType =
  | 'send_reply'
  | 'send_follow_up'
  | 'create_callback_task'
  | 'create_handover'
  | 'mark_hot_lead'
  | 'assign_owner'
  | 'pause_sequence'
  | 'resume_sequence'
  | 'escalate_thread'
  | 'send_client_update';

export interface Action {
  id: string;
  thread_id: string | null;
  campaign_id: string | null;
  contact_id: string | null;
  action_type: ActionType;
  title: string;
  draft_subject: string | null;
  draft_body: string | null;
  reason: string | null;
  confidence: number | null;
  risk_level: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'snoozed';
  edited_payload: { subject?: string; body?: string } | null;
  created_at: string;
}
