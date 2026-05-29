import type pg from 'pg';

export interface SendingDomainRow {
  id: string;
  tenant_id: string;
  domain: string;
  verified: boolean;
  spf_ok: boolean;
  dmarc_ok: boolean;
  last_checked_at: Date | null;
  created_at: Date;
}

export async function listSendingDomains(pool: pg.Pool, tenantId: string): Promise<SendingDomainRow[]> {
  const r = await pool.query<SendingDomainRow>(
    `SELECT id, tenant_id, domain, verified, spf_ok, dmarc_ok, last_checked_at, created_at
     FROM sending_domains WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
  );
  return r.rows;
}

export async function createSendingDomain(
  pool: pg.Pool,
  input: { tenantId: string; domain: string },
): Promise<SendingDomainRow> {
  const r = await pool.query<SendingDomainRow>(
    `INSERT INTO sending_domains(tenant_id, domain)
     VALUES ($1, $2)
     RETURNING id, tenant_id, domain, verified, spf_ok, dmarc_ok, last_checked_at, created_at`,
    [input.tenantId, input.domain],
  );
  return r.rows[0];
}

export async function getSendingDomain(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<SendingDomainRow | null> {
  const r = await pool.query<SendingDomainRow>(
    `SELECT id, tenant_id, domain, verified, spf_ok, dmarc_ok, last_checked_at, created_at
     FROM sending_domains WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function setDomainVerification(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  { spfOk, dmarcOk }: { spfOk: boolean; dmarcOk: boolean },
): Promise<SendingDomainRow | null> {
  const r = await pool.query<SendingDomainRow>(
    `UPDATE sending_domains
     SET spf_ok = $3, dmarc_ok = $4, verified = ($3 AND $4), last_checked_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, tenant_id, domain, verified, spf_ok, dmarc_ok, last_checked_at, created_at`,
    [tenantId, id, spfOk, dmarcOk],
  );
  return r.rows[0] ?? null;
}

export async function deleteSendingDomain(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM sending_domains WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rowCount === 1;
}
