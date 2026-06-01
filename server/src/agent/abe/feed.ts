import type pg from 'pg';

export type FeedKind = 'proposed' | 'pending_approval' | 'executed' | 'reported';

export interface FeedEntry {
  playId: string;
  at: string;   // ISO timestamp
  kind: FeedKind;
  text: string; // first-person Abe narration
}

interface FeedRow {
  id: string;
  status: string;
  audience_size: number;
  created_at: Date;
  updated_at: Date;
  executed_at: Date | null;
  sends: number | null;
  opens: number | null;
  reactivations: number | null;
  outcome_updated_at: Date | null;
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/**
 * Derive a reverse-chronological, first-person activity feed for a tenant from plays and
 * their play-level (touch_index = 0) outcomes. No dedicated activity table (v1 decision):
 * entries are synthesized from play status + timestamps + outcome numbers.
 */
export async function buildFeed(pool: pg.Pool, tenantId: string): Promise<FeedEntry[]> {
  const r = await pool.query<FeedRow>(
    `SELECT p.id,
            p.status,
            (p.audience_snapshot->>'size')::int AS audience_size,
            p.created_at,
            p.updated_at,
            p.executed_at,
            o.sends,
            o.opens,
            o.reactivations,
            o.updated_at AS outcome_updated_at
       FROM agent_plays p
       LEFT JOIN agent_play_outcomes o ON o.play_id = p.id AND o.touch_index = 0
      WHERE p.tenant_id = $1
      ORDER BY p.created_at DESC`,
    [tenantId],
  );

  const entries: FeedEntry[] = [];
  for (const row of r.rows) {
    const size = row.audience_size ?? 0;

    // Always: the moment Abe proposed the play.
    entries.push({
      playId: row.id,
      at: row.created_at.toISOString(),
      kind: 'proposed',
      text: `Abe here — I lined up a win-back for ${size} dormant ${size === 1 ? 'contact' : 'contacts'}.`,
    });

    if (row.status === 'pending_approval') {
      entries.push({
        playId: row.id,
        at: row.updated_at.toISOString(),
        kind: 'pending_approval',
        text: `I sent this win-back to your line manager for sign-off — waiting on approval.`,
      });
    }

    if (row.executed_at) {
      entries.push({
        playId: row.id,
        at: row.executed_at.toISOString(),
        kind: 'executed',
        text: `I started sending the win-back sequence to ${size} ${size === 1 ? 'contact' : 'contacts'}.`,
      });
    }

    // Reported: only once we have measured outcomes (an outcome row with sends recorded).
    if (row.sends != null && row.sends > 0 && row.outcome_updated_at) {
      const reacts = row.reactivations ?? 0;
      const opens = row.opens ?? 0;
      entries.push({
        playId: row.id,
        at: row.outcome_updated_at.toISOString(),
        kind: 'reported',
        text:
          `Update on the last win-back: ${row.sends} sent, ${opens} ${opens === 1 ? 'open' : 'opens'}, ` +
          `${reacts} reactivated (${pct(reacts, row.sends)}%).`,
      });
    }
  }

  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return entries;
}
