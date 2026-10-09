// Microsoft 365 device-code OAuth for IMAP (XOAUTH2).
//
// Exchange Online permanently disabled Basic auth for IMAP, so we authenticate
// the way desktop mail clients do: a one-time device-code sign-in by the mailbox
// owner yields a refresh token (stored encrypted), and every sync exchanges it
// for a short-lived access token passed to ImapFlow as XOAUTH2.
//
// We use a well-known PUBLIC mail-client application id by default (Mozilla
// Thunderbird's), exactly like other IMAP tools — no Azure app registration or
// admin consent is required for delegated IMAP access in a default tenant.

export const DEFAULT_MS_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753'; // Thunderbird (public client)
export const DEFAULT_MS_TENANT = 'common';
// Resource URI must be outlook.office.com (what Thunderbird's app registration
// grants) — outlook.office365.com is rejected with AADSTS70011 invalid_scope.
// The token still works against the outlook.office365.com IMAP endpoint.
export const IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';
export const SMTP_SCOPE = 'https://outlook.office.com/SMTP.Send offline_access';
// Combined scope for "Connect M365" — one consent grants both IMAP + SMTP access.
// The resulting refresh token can be used for IMAP (resolveImapCreds refreshes with IMAP_SCOPE)
// and SMTP (resolveSmtpCreds refreshes with SMTP_SCOPE) independently.
export const M365_FULL_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access';
// Graph send bypasses SMTP-AUTH entirely — uses the Graph HTTP API with a delegated Mail.Send token.
// We use the well-known "Microsoft Graph Command Line Tools" public client app (user-consentable,
// no admin consent required for delegated Mail.Send in default tenants).
export const GRAPH_SEND_SCOPE = 'https://graph.microsoft.com/Mail.Send offline_access';
export const DEFAULT_MS_GRAPH_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'; // Microsoft Graph Command Line Tools (public client)

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>;
}>;

export interface DeviceCodeStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  message: string;
}

export interface OauthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
}

export type DeviceCodePollResult =
  | { status: 'ok'; tokens: OauthTokens }
  | { status: 'pending' }
  | { status: 'failed'; error: string };

const form = (data: Record<string, string>): string =>
  Object.entries(data).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

async function post(fetchImpl: FetchLike, url: string, data: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(data),
  });
  return (await res.json()) as Record<string, unknown>;
}

const loginBase = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;

export async function startDeviceCode(opts?: {
  clientId?: string; tenant?: string; fetchImpl?: FetchLike; scope?: string;
}): Promise<DeviceCodeStart> {
  const clientId = opts?.clientId ?? DEFAULT_MS_CLIENT_ID;
  const tenant = opts?.tenant ?? DEFAULT_MS_TENANT;
  const fetchImpl = opts?.fetchImpl ?? (fetch as unknown as FetchLike);
  const scope = opts?.scope ?? IMAP_SCOPE;
  const body = await post(fetchImpl, `${loginBase(tenant)}/devicecode`, { client_id: clientId, scope });
  if (typeof body.device_code !== 'string') {
    throw new Error(`device code request failed: ${String(body.error_description ?? body.error ?? 'unknown')}`);
  }
  return {
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri ?? 'https://microsoft.com/devicelogin'),
    deviceCode: body.device_code,
    intervalSeconds: Number(body.interval ?? 5),
    expiresInSeconds: Number(body.expires_in ?? 900),
    message: String(body.message ?? ''),
  };
}

/** One poll of the token endpoint. Call repeatedly (every intervalSeconds) until not 'pending'. */
export async function pollDeviceCode(opts: {
  deviceCode: string; clientId?: string; tenant?: string; fetchImpl?: FetchLike;
}): Promise<DeviceCodePollResult> {
  const clientId = opts.clientId ?? DEFAULT_MS_CLIENT_ID;
  const tenant = opts.tenant ?? DEFAULT_MS_TENANT;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const body = await post(fetchImpl, `${loginBase(tenant)}/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: opts.deviceCode,
  });
  if (typeof body.access_token === 'string') {
    return {
      status: 'ok',
      tokens: {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
        expiresInSeconds: Number(body.expires_in ?? 3600),
      },
    };
  }
  const err = String(body.error ?? 'unknown');
  if (err === 'authorization_pending' || err === 'slow_down') return { status: 'pending' };
  return { status: 'failed', error: String(body.error_description ?? err) };
}

/** Exchange a refresh token for a fresh access token (Microsoft also rotates the refresh token). */
export async function refreshAccessToken(opts: {
  refreshToken: string; clientId?: string; tenant?: string; fetchImpl?: FetchLike; scope?: string;
}): Promise<OauthTokens> {
  const clientId = opts.clientId ?? DEFAULT_MS_CLIENT_ID;
  const tenant = opts.tenant ?? DEFAULT_MS_TENANT;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const scope = opts.scope ?? IMAP_SCOPE;
  const body = await post(fetchImpl, `${loginBase(tenant)}/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: opts.refreshToken,
    scope,
  });
  if (typeof body.access_token !== 'string') {
    throw new Error(`token refresh failed: ${String(body.error_description ?? body.error ?? 'unknown')}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresInSeconds: Number(body.expires_in ?? 3600),
  };
}
