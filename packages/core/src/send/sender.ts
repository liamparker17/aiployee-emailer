import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type pg from 'pg';
import { refreshAccessToken, SMTP_SCOPE, DEFAULT_MS_CLIENT_ID, DEFAULT_MS_TENANT, type OauthTokens } from '../receive/msOauth.js';
import { updateSmtpRefreshToken, type SmtpConfigRow } from '../repos/smtpConfigs.js';

export interface SmtpCreds {
  host: string; port: number; secure: boolean; user: string; pass?: string; accessToken?: string;
}

type SmtpRefresher = (opts: {
  refreshToken: string; clientId?: string; tenant?: string; scope?: string;
}) => Promise<OauthTokens>;

/** Resolve credentials for sending: refresh an OAuth token for xoauth2 configs, else use the password. */
export async function resolveSmtpCreds(
  pool: pg.Pool,
  encKey: Buffer,
  cfg: SmtpConfigRow & { password: string | null; refreshToken: string | null },
  refresh: SmtpRefresher = refreshAccessToken,
): Promise<SmtpCreds> {
  const base = { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.username };
  if (cfg.auth_type === 'xoauth2') {
    if (!cfg.refreshToken) throw new Error('xoauth2 SMTP config has no refresh token — reconnect the mailbox');
    const tokens = await refresh({
      refreshToken: cfg.refreshToken,
      clientId: cfg.oauth_client_id ?? DEFAULT_MS_CLIENT_ID,
      tenant: cfg.oauth_tenant ?? DEFAULT_MS_TENANT,
      scope: SMTP_SCOPE,
    });
    if (tokens.refreshToken && tokens.refreshToken !== cfg.refreshToken) {
      await updateSmtpRefreshToken(pool, encKey, cfg.id, tokens.refreshToken);
    }
    return { ...base, accessToken: tokens.accessToken };
  }
  if (!cfg.password) throw new Error('SMTP config has no stored password');
  return { ...base, pass: cfg.password };
}

export function buildTransport(creds: SmtpCreds): Transporter {
  const opts: SMTPTransport.Options = {
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: creds.accessToken
      ? { type: 'OAuth2', user: creds.user, accessToken: creds.accessToken }
      : { user: creds.user, pass: creds.pass! },
  };
  return nodemailer.createTransport(opts);
}
