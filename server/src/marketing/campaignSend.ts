import type pg from 'pg';
import { AppError } from '@aiployee/core';
import { render } from '../send/render.js';
import { insertEmail } from '../repos/emails.js';
import { isSuppressed } from '@aiployee/core';
import { getContactsByIds, type ContactRow } from '@aiployee/core';
import { listMembers } from '@aiployee/core';
import { getSegment, listSegmentContactIds } from '@aiployee/core';
import { getCampaign, setCampaignStatus } from '../repos/campaigns.js';
import { signUnsubToken } from './unsubscribe.js';

function varsFor(c: ContactRow): Record<string, string> {
  const out: Record<string, string> = { email: c.email, name: c.name ?? '' };
  for (const [k, v] of Object.entries(c.attributes ?? {})) out[k] = v == null ? '' : String(v);
  return out;
}

/**
 * Send (or schedule) a campaign: resolve its audience, drop unsubscribed/suppressed
 * recipients, render per-contact, append a signed unsubscribe footer, and enqueue one
 * `emails` row per recipient (tagged with campaign_id) for the cron worker to drip out.
 */
export async function sendCampaign(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string; tenantId: string; campaignId: string; now?: Date;
}): Promise<{ queued: number; skipped: number }> {
  const { pool, encKey, baseUrl, tenantId, campaignId } = args;
  const now = args.now ?? new Date();
  const c = await getCampaign(pool, tenantId, campaignId);
  if (!c) throw new AppError('not_found', 404, 'Campaign not found');
  if (c.status !== 'draft' && c.status !== 'scheduled') throw new AppError('already_sent', 400, 'Campaign has already been sent or canceled');
  if (!c.subject || !c.body_html) throw new AppError('no_content', 400, 'Campaign needs a subject and body');

  // Resolve audience → contact ids.
  let contactIds: string[];
  if (c.audience_type === 'list') {
    contactIds = (await listMembers(pool, tenantId, c.audience_id)).map(m => m.id);
  } else {
    const seg = await getSegment(pool, tenantId, c.audience_id);
    contactIds = seg ? await listSegmentContactIds(pool, tenantId, seg.filter) : [];
  }

  const contacts = await getContactsByIds(pool, tenantId, contactIds, true); // subscribed only
  const base = baseUrl.replace(/\/+$/, '');
  let queued = 0, skipped = 0;

  for (const contact of contacts) {
    if (await isSuppressed(pool, tenantId, contact.email)) { skipped++; continue; }
    const vars = varsFor(contact);
    const subject = render(c.subject, vars, { escape: false });
    const body = render(c.body_html, vars); // escape variable values in HTML
    const token = signUnsubToken(tenantId, contact.id, encKey);
    const unsubUrl = `${base}/v1/unsubscribe/${token}`;
    const footer = `<div style="margin-top:28px;padding-top:12px;border-top:1px solid #eee;font-size:12px;color:#888">` +
      `<a href="${unsubUrl}" style="color:#888">Unsubscribe</a></div>`;
    await insertEmail(pool, {
      tenantId, senderId: c.sender_id, toAddr: contact.email,
      subject, bodyHtml: body + footer, status: 'queued',
      scheduledFor: c.scheduled_for, campaignId: c.id, listUnsubscribe: unsubUrl,
    });
    queued++;
  }

  const scheduled = c.scheduled_for && c.scheduled_for.getTime() > now.getTime();
  await setCampaignStatus(pool, tenantId, campaignId, scheduled ? 'scheduled' : 'sending');
  return { queued, skipped };
}
