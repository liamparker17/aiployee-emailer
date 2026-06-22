import type pg from 'pg';
import { createSmtpConfigGraph, type SmtpConfigRow } from '../repos/smtpConfigs.js';
import { createSender, getSenderByEmail, updateSenderSmtpConfig, type Sender } from '../repos/senders.js';

/**
 * Idempotently make `email` send via Microsoft Graph:
 * - Creates a graph smtp_config (auth_type='graph') with the given refresh token.
 * - If a sender already exists for that email in this tenant, upgrades its smtp_config_id to the new graph config.
 * - If no sender exists, creates one pointing at the new graph config.
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

  const existing = await getSenderByEmail(pool, input.tenantId, input.username);
  const sender = existing
    ? await updateSenderSmtpConfig(pool, input.tenantId, existing.id, smtpConfig.id)
    : await createSender(pool, {
        tenantId: input.tenantId,
        email: input.username,
        displayName: input.displayName ?? input.name,
        smtpConfigId: smtpConfig.id,
        isDefault: input.isDefault ?? false,
      });

  return { sender, smtpConfig };
}
