export interface AbeGoal {
  id: string; enabled: boolean;
  dormant_window_days: number; auto_fire_max_audience: number;
  max_touches: number; touch_spacing_days: number;
  line_manager_email: string | null; line_manager_verified_at: string | null;
  brand_voice: string | null;
}
export interface AbeTouch { index: number; subject: string; body_html: string; scheduled_offset_days: number }
export type AbePlayStatus = 'proposed'|'pending_approval'|'approved'|'rejected'|'executing'|'done'|'archived';
export interface AbePlay {
  id: string; status: AbePlayStatus; risk_score: number;
  audience_snapshot: { contact_ids: string[]; size: number };
  touches: AbeTouch[]; rejection_reason: string | null;
  executed_at: string | null; created_at: string;
}
export interface AbeFeedEntry { playId: string; at: string; kind: string; text: string }
