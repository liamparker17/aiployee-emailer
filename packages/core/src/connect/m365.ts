import type pg from 'pg';
import { createSmtpConfigOauth, type SmtpConfigRow } from '../repos/smtpConfigs.js';
import { createImapConfigOauth, type ImapConfigRow } from '../repos/imapConfigs.js';
import { createSender, type Sender } from '../repos/senders.js';

/**
 * Create a full M365 connection (send + sync) from one OAuth consent.
 * One refresh token (from a M365_FULL_SCOPE device-code grant) is shared
 * by both the SMTP config and the IMAP config. resolveSmtpCreds and
 * resolveImapCreds will each exchange it for a scope-appropriate access token.
 */
export async function createM365Connection(
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
): Promise<{ sender: Sender; smtpConfig: SmtpConfigRow; imapConfig: ImapConfigRow }> {
  const smtpConfig = await createSmtpConfigOauth(pool, key, {
    tenantId: input.tenantId,
    name: input.name,
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
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

  const imapConfig = await createImapConfigOauth(pool, key, {
    tenantId: input.tenantId,
    senderId: sender.id,
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    username: input.username,
    clientId: input.clientId,
    oauthTenant: input.oauthTenant,
    refreshToken: input.refreshToken,
    enabled: true,
  });

  return { sender, smtpConfig, imapConfig };
}
