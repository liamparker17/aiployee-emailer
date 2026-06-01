import type pg from 'pg';
import type { PlayRow } from '../../repos/agentPlays.js';
import type { Sender } from '../../repos/senders.js';
import { insertEmail } from '../../repos/emails.js';
import { findEligibleContacts } from '../../repos/agentEligible.js';
import { signUnsubToken } from '../../marketing/unsubscribe.js';

function unsubFooter(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/v1/unsubscribe/${token}`;
  return `<hr/><p style="font-size:12px;color:#888">If you'd rather not hear from us, <a href="${url}">unsubscribe</a>.</p>`;
}

export async function queuePlayTouch(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string; play: PlayRow; touchIndex: number; sender: Sender; reengagedSince: Date | null;
}): Promise<{ queued: number; skipped: number }> {
  const { pool, encKey, baseUrl, play, touchIndex, sender, reengagedSince } = args;
  const touch = play.touches[touchIndex];
  if (!touch) throw new Error(`queuePlayTouch: no touch at index ${touchIndex}`);

  const ids = play.audience_snapshot.contact_ids;
  const eligible = await findEligibleContacts(pool, play.tenant_id, ids, reengagedSince);
  const scheduledFor = new Date(Date.now() + touch.scheduled_offset_days * 24 * 3600 * 1000);

  let queued = 0;
  for (const c of eligible) {
    const token = signUnsubToken(play.tenant_id, c.id, encKey);
    const bodyHtml = `${touch.body_html}${unsubFooter(baseUrl, token)}`;
    await insertEmail(pool, {
      tenantId: play.tenant_id, senderId: sender.id, toAddr: c.email,
      subject: touch.subject, bodyHtml, status: 'queued', scheduledFor, playId: play.id,
    });
    queued += 1;
  }

  await pool.query(
    `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends) VALUES ($1,$2,$3,$4)`,
    [play.id, play.tenant_id, touchIndex, queued],
  );
  return { queued, skipped: ids.length - queued };
}
