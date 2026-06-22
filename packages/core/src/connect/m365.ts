import type pg from 'pg';
import { createSmtpConfigOauth, type SmtpConfigRow } from '../repos/smtpConfigs.js';
import {
  createImapConfigOauth,
  getImapConfigByUsername,
  upgradeImapConfigToOauth,
  type ImapConfigRow,
} from '../repos/imapConfigs.js';
import {
  createSender,
  getSenderByEmail,
  updateSenderSmtpConfig,
  type Sender,
} from '../repos/senders.js';

/**
 * Idempotent "upsert" of a full M365 connection (send + sync) from one OAuth consent.
 *
 * Rules:
 *  1. SMTP config — always creates a fresh one (no unique constraint on username).
 *  2. Sender — upserts by (tenant_id, email): if a sender already exists for this
 *     mailbox, its smtp_config_id is updated to point at the new smtp_config.
 *  3. IMAP config — upserts by (tenant_id, username): if one already exists (e.g.
 *     from an old inbox-only flow), it is UPGRADED in-place (auth_type→xoauth2,
 *     new tokens, sender_id linked). Existing inbound_emails rows are preserved
 *     because the row id never changes.
 *
 * Safe to call repeatedly: no duplicates, no unique-constraint violations.
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
  // 1. Fresh SMTP config (smtp_configs has no unique-on-username constraint).
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

  // 2. Sender — upsert by (tenant_id, email).
  const existingSender = await getSenderByEmail(pool, input.tenantId, input.username);
  let sender: Sender;
  if (existingSender) {
    sender = await updateSenderSmtpConfig(pool, input.tenantId, existingSender.id, smtpConfig.id);
  } else {
    sender = await createSender(pool, {
      tenantId: input.tenantId,
      email: input.username,
      displayName: input.displayName ?? input.name,
      smtpConfigId: smtpConfig.id,
      isDefault: input.isDefault ?? false,
    });
  }

  // 3. IMAP config — upsert by (tenant_id, username).
  //    DO NOT delete the existing row — inbound_emails references it via FK.
  const existingImap = await getImapConfigByUsername(pool, input.tenantId, input.username);
  let imapConfig: ImapConfigRow;
  if (existingImap) {
    imapConfig = await upgradeImapConfigToOauth(pool, key, existingImap.id, {
      senderId: sender.id,
      clientId: input.clientId,
      oauthTenant: input.oauthTenant,
      refreshToken: input.refreshToken,
    });
  } else {
    imapConfig = await createImapConfigOauth(pool, key, {
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
  }

  return { sender, smtpConfig, imapConfig };
}
