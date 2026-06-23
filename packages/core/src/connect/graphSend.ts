import type pg from 'pg';
import { createSmtpConfigGraph, upgradeSmtpConfigToGraph, type SmtpConfigRow } from '../repos/smtpConfigs.js';
import { createSender, getSenderByEmail, type Sender } from '../repos/senders.js';

/**
 * Idempotently make `email` send via Microsoft Graph:
 * - If a sender already exists for that email in this tenant, upgrades its CURRENT smtp_config
 *   to Graph in-place (no new row → no UNIQUE name collision).
 * - If no sender exists, creates a fresh Graph smtp_config + sender.
 */
export async function createGraphSender(
  pool: pg.Pool,
  key: Buffer,
  input: {
    tenantId: string;
    username: string;
    name: string;
    fromDomain: string;
    displayName?: string;
    isDefault?: boolean;
    clientId: string;
    oauthTenant: string;
    refreshToken: string;
  },
): Promise<{ sender: Sender; smtpConfig: SmtpConfigRow }> {
  const existing = await getSenderByEmail(pool, input.tenantId, input.username);

  if (existing) {
    // Upgrade the sender's CURRENT smtp_config to Graph in place — no new row, no name collision.
    const smtpConfig = await upgradeSmtpConfigToGraph(pool, key, existing.smtp_config_id, {
      clientId: input.clientId,
      oauthTenant: input.oauthTenant,
      refreshToken: input.refreshToken,
    });
    return { sender: existing, smtpConfig };
  }

  // Brand-new mailbox: create a fresh Graph config + sender.
  const smtpConfig = await createSmtpConfigGraph(pool, key, {
    tenantId: input.tenantId,
    name: input.name,
    username: input.username,
    fromDomain: input.fromDomain,
    isDefault: input.isDefault ?? false,
    clientId: input.clientId,
    oauthTenant: input.oauthTenant,
    refreshToken: input.refreshToken,
  });
  const sender = await createSender(pool, {
    tenantId: input.tenantId,
    email: input.username,
    displayName: input.displayName ?? input.name,
    smtpConfigId: smtpConfig.id,
    isDefault: input.isDefault ?? false,
  });

  return { sender, smtpConfig };
}
