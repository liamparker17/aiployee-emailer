import type pg from 'pg';

// Attribution window: a dormant contact counts as "reactivated" only if they open or
// click a play email within this many days AFTER that email was sent. 14 days balances
// catching genuine win-backs against attributing unrelated later activity to the play.
export const ATTRIBUTION_DAYS = 14;

export interface PlayEngagement {
  sent: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  reactivations: number;
}

/**
 * Play-level engagement for one play, aggregated across ALL its touch emails
 * (emails.play_id = $1). Reactivations = distinct audience contacts (matched
 * case-insensitively on to_addr ↔ contacts.email) with an open/click event dated
 * within ATTRIBUTION_DAYS of the email's send time (sent_at, falling back to created_at).
 * Mirrors the correlated-subquery style of engagementSummary() in repos/emailEvents.ts.
 */
export async function aggregatePlayEngagement(pool: pg.Pool, playId: string): Promise<PlayEngagement> {
  const r = await pool.query<{
    sent: number; opens: number; unique_opens: number; clicks: number; unique_clicks: number; reactivations: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM emails WHERE play_id = $1 AND status IN ('sent','delivered')) AS sent,
       (SELECT count(*)::int FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          WHERE e.play_id = $1 AND ev.type = 'open') AS opens,
       (SELECT count(DISTINCT ev.email_id)::int FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          WHERE e.play_id = $1 AND ev.type = 'open') AS unique_opens,
       (SELECT count(*)::int FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          WHERE e.play_id = $1 AND ev.type = 'click') AS clicks,
       (SELECT count(DISTINCT ev.email_id)::int FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          WHERE e.play_id = $1 AND ev.type = 'click') AS unique_clicks,
       (SELECT count(DISTINCT c.id)::int
          FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          JOIN contacts c ON c.tenant_id = e.tenant_id AND lower(c.email) = lower(e.to_addr)
          WHERE e.play_id = $1
            AND ev.type IN ('open','click')
            AND ev.created_at >= COALESCE(e.sent_at, e.created_at)
            AND ev.created_at <= COALESCE(e.sent_at, e.created_at) + make_interval(days => $2)
       ) AS reactivations`,
    [playId, ATTRIBUTION_DAYS],
  );
  const row = r.rows[0];
  return {
    sent: row.sent,
    opens: row.opens,
    uniqueOpens: row.unique_opens,
    clicks: row.clicks,
    uniqueClicks: row.unique_clicks,
    reactivations: row.reactivations,
  };
}

/**
 * Roll up play-level engagement (via aggregatePlayEngagement) into the touch_index = 0
 * agent_play_outcomes row for this play, and stamp window_closed_at once the attribution
 * window has fully elapsed for the whole sequence:
 *   now() >= executed_at + (lastTouchIndex * touch_spacing_days days) + ATTRIBUTION_DAYS
 * No-op if the play has not executed or has no touch_index = 0 outcome row yet.
 */
export async function updatePlayOutcomes(pool: pg.Pool, playId: string): Promise<void> {
  const meta = await pool.query<{
    executed_at: Date | null; touch_spacing_days: number; touch_count: number;
  }>(
    `SELECT p.executed_at,
            g.touch_spacing_days,
            jsonb_array_length(p.touches)::int AS touch_count
       FROM agent_plays p
       JOIN agent_goals g ON g.id = p.goal_id
      WHERE p.id = $1`,
    [playId],
  );
  if (meta.rows.length === 0) return;
  const { executed_at, touch_spacing_days, touch_count } = meta.rows[0];

  const eng = await aggregatePlayEngagement(pool, playId);

  // Window is closed only once the last touch's 14-day window has elapsed.
  let closed = false;
  if (executed_at) {
    const lastTouchIndex = Math.max(0, touch_count - 1);
    const windowEndMs =
      executed_at.getTime() +
      (lastTouchIndex * touch_spacing_days + ATTRIBUTION_DAYS) * 24 * 60 * 60 * 1000;
    closed = Date.now() >= windowEndMs;
  }

  await pool.query(
    `UPDATE agent_play_outcomes
        SET opens = $2,
            clicks = $3,
            reactivations = $4,
            window_closed_at = CASE WHEN $5::boolean THEN COALESCE(window_closed_at, now()) ELSE window_closed_at END,
            updated_at = now()
      WHERE play_id = $1 AND touch_index = 0 AND window_closed_at IS NULL`,
    [playId, eng.opens, eng.clicks, eng.reactivations, closed],
  );
}

/**
 * A short, first-person-free learning hint summarizing the tenant's most recent completed
 * (status 'done') play that has recorded sends. Fed into the NEXT shift's drafting so Abe
 * can reference how the last win-back performed. Returns null if there is nothing to learn from.
 */
export async function lastCompletedPlayOutcome(pool: pg.Pool, tenantId: string): Promise<string | null> {
  const r = await pool.query<{ sends: number; opens: number; reactivations: number }>(
    `SELECT o.sends, o.opens, o.reactivations
       FROM agent_plays p
       JOIN agent_play_outcomes o ON o.play_id = p.id AND o.touch_index = 0
      WHERE p.tenant_id = $1 AND p.status = 'done' AND o.sends > 0
      ORDER BY p.executed_at DESC NULLS LAST, p.created_at DESC
      LIMIT 1`,
    [tenantId],
  );
  if (r.rows.length === 0) return null;
  const { sends, opens, reactivations } = r.rows[0];
  const reactPct = sends > 0 ? Math.round((reactivations / sends) * 100) : 0;
  const openPct = sends > 0 ? Math.round((opens / sends) * 100) : 0;
  return `Your last win-back reached ${sends} contacts; ${openPct}% opened and ${reactPct}% reactivated.`;
}

export interface PlayOutcomeRow {
  id: string;
  play_id: string;
  tenant_id: string;
  touch_index: number;
  sends: number;
  opens: number;
  clicks: number;
  reactivations: number;
  window_closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** All outcome rows for a play (tenant-scoped), ordered by touch index. */
export async function getPlayOutcomes(pool: pg.Pool, tenantId: string, playId: string): Promise<PlayOutcomeRow[]> {
  const r = await pool.query<PlayOutcomeRow>(
    `SELECT * FROM agent_play_outcomes
      WHERE tenant_id = $1 AND play_id = $2
      ORDER BY touch_index ASC`,
    [tenantId, playId],
  );
  return r.rows;
}
