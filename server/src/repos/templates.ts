import type pg from 'pg';
import { extractVariables } from '../send/render.js';

export interface Template {
  id: string; tenant_id: string; name: string; subject: string;
  body_html: string; body_text: string | null; variables: string[];
  display_name: string | null;
  created_at: Date; updated_at: Date;
}

function vars(input: { subject: string; bodyHtml: string; bodyText?: string | null }): string[] {
  const set = new Set<string>([
    ...extractVariables(input.subject),
    ...extractVariables(input.bodyHtml),
    ...(input.bodyText ? extractVariables(input.bodyText) : []),
  ]);
  return [...set];
}

export async function createTemplate(pool: pg.Pool, input: {
  tenantId: string; name: string; subject: string; bodyHtml: string; bodyText?: string | null;
  displayName?: string | null;
}): Promise<Template> {
  const v = vars(input);
  const r = await pool.query<Template>(
    `INSERT INTO templates(tenant_id,name,subject,body_html,body_text,variables,display_name)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     RETURNING id, tenant_id, name, subject, body_html, body_text, variables, display_name, created_at, updated_at`,
    [input.tenantId, input.name, input.subject, input.bodyHtml, input.bodyText ?? null, JSON.stringify(v), input.displayName?.trim() || null],
  );
  return r.rows[0];
}

export async function updateTemplate(pool: pg.Pool, tenantId: string, id: string, input: {
  name?: string; subject?: string; bodyHtml?: string; bodyText?: string | null;
  displayName?: string | null;
}): Promise<Template | null> {
  const existing = await getTemplateById(pool, tenantId, id);
  if (!existing) return null;
  const merged = {
    name: input.name ?? existing.name,
    subject: input.subject ?? existing.subject,
    bodyHtml: input.bodyHtml ?? existing.body_html,
    bodyText: input.bodyText !== undefined ? input.bodyText : existing.body_text,
    displayName: input.displayName !== undefined ? (input.displayName?.trim() || null) : existing.display_name,
  };
  const v = vars({ subject: merged.subject, bodyHtml: merged.bodyHtml, bodyText: merged.bodyText });
  const r = await pool.query<Template>(
    `UPDATE templates SET name=$3, subject=$4, body_html=$5, body_text=$6, variables=$7::jsonb, display_name=$8, updated_at=now()
     WHERE tenant_id=$1 AND id=$2
     RETURNING id, tenant_id, name, subject, body_html, body_text, variables, display_name, created_at, updated_at`,
    [tenantId, id, merged.name, merged.subject, merged.bodyHtml, merged.bodyText, JSON.stringify(v), merged.displayName],
  );
  return r.rows[0] ?? null;
}

export async function listTemplates(pool: pg.Pool, tenantId: string): Promise<Template[]> {
  const r = await pool.query<Template>(
    `SELECT id, tenant_id, name, subject, body_html, body_text, variables, display_name, created_at, updated_at
     FROM templates WHERE tenant_id = $1 ORDER BY name`, [tenantId]);
  return r.rows;
}

export async function getTemplateById(pool: pg.Pool, tenantId: string, id: string): Promise<Template | null> {
  const r = await pool.query<Template>(
    `SELECT id, tenant_id, name, subject, body_html, body_text, variables, display_name, created_at, updated_at
     FROM templates WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function getTemplateByName(pool: pg.Pool, tenantId: string, name: string): Promise<Template | null> {
  const r = await pool.query<Template>(
    `SELECT id, tenant_id, name, subject, body_html, body_text, variables, display_name, created_at, updated_at
     FROM templates WHERE tenant_id = $1 AND name = $2`, [tenantId, name]);
  return r.rows[0] ?? null;
}

export async function deleteTemplate(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM templates WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}
