// server/src/agent/abe/executeAction.ts
import pg from 'pg';
import { insertEmail, AppError } from '@aiployee/core';
import { getAction, markActionExecuted } from '../../repos/agentActions.js';
import { getReplyDispatchInfo, setThreadAfterSend } from '../../repos/agentThreads.js';

export async function executeApprovedAction(deps: {
  pool: pg.Pool; tenantId: string; actionId: string;
}): Promise<{ emailId: string | null }> {
  const { pool, tenantId, actionId } = deps;
  const action = await getAction(pool, tenantId, actionId);
  if (!action) throw new AppError('not_found', 404, 'Action not found');

  if (action.action_type !== 'send_reply') {
    // Phase 1 executes only send_reply; other types are acknowledged here and given real
    // side-effects in later phases (tasks, handovers, sequence control).
    await markActionExecuted(pool, tenantId, actionId);
    return { emailId: null };
  }

  if (!action.thread_id) throw new AppError('no_thread', 422, 'send_reply action has no thread');
  const info = await getReplyDispatchInfo(pool, tenantId, action.thread_id);
  if (!info || !info.sender_id) throw new AppError('no_sender', 422, 'No sender resolvable for this thread');

  const edited = (action.edited_payload ?? {}) as { subject?: string; body?: string };
  const subject = edited.subject ?? action.draft_subject;
  const bodyHtml = edited.body ?? action.draft_body;
  if (!subject || !bodyHtml) throw new AppError('no_draft', 422, 'send_reply action has no draft to send');

  const email = await insertEmail(pool, {
    tenantId, senderId: info.sender_id, toAddr: info.to_addr,
    subject, bodyHtml, status: 'queued', campaignId: info.campaign_id,
  });

  await setThreadAfterSend(pool, tenantId, action.thread_id, email.id);
  await markActionExecuted(pool, tenantId, actionId);
  return { emailId: email.id };
}
