import type pg from 'pg';
import { getAgentForLaunch } from '../repos/callAgents.js';
import { claimPending, markLaunched, markFailed, completeFinishedCampaigns } from '../repos/callCampaigns.js';
import type { LaunchFn } from '../jobix/launchClient.js';
import { launchCall } from '../jobix/launchClient.js';

export type CheckSuppressed = (tenantId: string, phone: string) => Promise<boolean>;
const neverSuppressed: CheckSuppressed = async () => false;

export interface QueueOpts { batchSize: number; maxAttempts: number }
export interface QueueSummary { claimed: number; launched: number; failed: number; suppressed: number }

export async function runCallQueue(
  pool: pg.Pool, encKey: Buffer, opts: QueueOpts,
  launch: LaunchFn = launchCall, checkSuppressed: CheckSuppressed = neverSuppressed,
): Promise<QueueSummary> {
  const claimed = await claimPending(pool, opts.batchSize, opts.maxAttempts);
  const summary: QueueSummary = { claimed: claimed.length, launched: 0, failed: 0, suppressed: 0 };

  const agentCache = new Map<string, Awaited<ReturnType<typeof getAgentForLaunch>>>();

  for (const r of claimed) {
    try {
      if (await checkSuppressed(r.tenant_id, r.phone)) {
        await pool.query(`UPDATE call_campaign_recipients SET status = 'suppressed', updated_at = now() WHERE id = $1`, [r.id]);
        summary.suppressed++;
        continue;
      }
      const cacheKey = `${r.tenant_id}:${r.campaign_id}`;
      let agent = agentCache.get(cacheKey);
      if (agent === undefined) {
        const camp = await pool.query<{ agent_id: string }>(`SELECT agent_id FROM call_campaigns WHERE id = $1`, [r.campaign_id]);
        agent = camp.rows[0] ? await getAgentForLaunch(pool, encKey, r.tenant_id, camp.rows[0].agent_id) : null;
        agentCache.set(cacheKey, agent);
      }
      if (!agent) { await markFailed(pool, r.id, 'agent not found or key undecryptable'); summary.failed++; continue; }

      const res = await launch({
        companyKey: agent.companyKey, suid: r.suid, name: r.name, phone: r.phone,
        timezone: r.timezone ?? agent.defaultTimezone, values: r.values ?? {},
      });
      if (res.ok) { await markLaunched(pool, r.id, res.body); summary.launched++; }
      else { await markFailed(pool, r.id, `customer/save ${res.status}`); summary.failed++; }
    } catch (e) {
      await markFailed(pool, r.id, e instanceof Error ? e.message : String(e));
      summary.failed++;
    }
  }

  await completeFinishedCampaigns(pool, opts.maxAttempts);
  return summary;
}
