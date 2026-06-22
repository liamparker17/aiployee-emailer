import { describe, it, expect } from 'vitest';
import { resolveSmtpCreds } from '@aiployee/core';
import type { SmtpConfigRow } from '@aiployee/core';
import type pg from 'pg';

const KEY = Buffer.alloc(32, 7);
// Dummy pool — won't be called when refreshToken is unchanged
const dummyPool = {} as pg.Pool;

function makeOauthCfg(overrides?: Partial<SmtpConfigRow & { password: string | null; refreshToken: string | null }>) {
  const base: SmtpConfigRow & { password: string | null; refreshToken: string | null } = {
    id: 'cfg-1',
    tenant_id: 'ten-1',
    name: 'M365 SMTP',
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    username: 'user@example.com',
    from_domain: 'example.com',
    is_default: true,
    created_at: new Date(),
    auth_type: 'xoauth2',
    oauth_client_id: 'my-client-id',
    oauth_tenant: 'my-tenant',
    password: null,
    refreshToken: 'rt',
  };
  return { ...base, ...overrides };
}

function makePasswordCfg() {
  const base: SmtpConfigRow & { password: string | null; refreshToken: string | null } = {
    id: 'cfg-2',
    tenant_id: 'ten-1',
    name: 'SES SMTP',
    host: 'email-smtp.eu-west-1.amazonaws.com',
    port: 587,
    secure: false,
    username: 'AKIAIOSFODNN7EXAMPLE',
    from_domain: 'example.com',
    is_default: false,
    created_at: new Date(),
    auth_type: 'password',
    oauth_client_id: null,
    oauth_tenant: null,
    password: 'pw',
    refreshToken: null,
  };
  return base;
}

describe('resolveSmtpCreds', () => {
  it('xoauth2 cfg: calls refresher and returns accessToken (no pass)', async () => {
    const fakeRefresh = async (_opts: { refreshToken: string; clientId?: string; tenant?: string; scope?: string }) => ({
      accessToken: 'AT',
      refreshToken: 'rt', // same token — no DB write needed
      expiresInSeconds: 3600,
    });

    const result = await resolveSmtpCreds(dummyPool, KEY, makeOauthCfg(), fakeRefresh);

    expect(result.accessToken).toBe('AT');
    expect(result).not.toHaveProperty('pass');
    expect(result.host).toBe('smtp.office365.com');
    expect(result.user).toBe('user@example.com');
  });

  it('password cfg: returns pass (no accessToken)', async () => {
    const result = await resolveSmtpCreds(dummyPool, KEY, makePasswordCfg());

    expect(result.pass).toBe('pw');
    expect(result.accessToken).toBeUndefined();
    expect(result.user).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('xoauth2 cfg with null refreshToken: throws /reconnect/', async () => {
    const fakeRefresh = async () => ({ accessToken: 'AT', refreshToken: null, expiresInSeconds: 3600 });
    const cfg = makeOauthCfg({ refreshToken: null });

    await expect(resolveSmtpCreds(dummyPool, KEY, cfg, fakeRefresh)).rejects.toThrow(/reconnect/);
  });
});
