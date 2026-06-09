import type pg from 'pg';
import { AppError } from '@aiployee/core';
import { getTriggerForFire, recordFire, touchLastFired, type FireSource } from '../repos/jobixTriggers.js';

export interface FireResult {
  ok: boolean; httpStatus: number | null; responseSnippet: string | null;
  error: string | null; renderedPayload: string; unresolved: string[];
}

interface FireArgs { tenantId: string; triggerId: string; vars: Record<string, string>; source: FireSource; userId?: string | null }

function render(template: string, vars: Record<string, string>): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const text = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) { unresolved.push(key); return ''; }
    return JSON.stringify(String(v)).slice(1, -1);
  });
  return { text, unresolved };
}

export async function fireTrigger(pool: pg.Pool, encKey: Buffer, args: FireArgs): Promise<FireResult> {
  const t = await getTriggerForFire(pool, encKey, args.tenantId, args.triggerId);
  if (!t) throw new AppError('not_found', 404, 'Trigger not found');
  if (!t.active && args.source !== 'test') throw new AppError('trigger_inactive', 400, 'Trigger is not active');

  const { text, unresolved } = render(t.payloadTemplate, args.vars ?? {});

  let bodyObj: Record<string, unknown>;
  try { bodyObj = JSON.parse(text) as Record<string, unknown>; }
  catch {
    const result: FireResult = { ok: false, httpStatus: null, responseSnippet: null, error: 'invalid_payload', renderedPayload: text, unresolved };
    await recordFire(pool, { tenantId: args.tenantId, triggerId: args.triggerId, source: args.source, vars: args.vars ?? {},
      httpStatus: null, ok: false, responseSnippet: null, error: 'invalid_payload', createdBy: args.userId ?? null });
    await touchLastFired(pool, args.tenantId, args.triggerId);
    return result;
  }

  let url = t.url;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t.tokenPlacement === 'bearer') headers['Authorization'] = `Bearer ${t.token}`;
  else if (t.tokenPlacement === 'header' && t.tokenParam) headers[t.tokenParam] = t.token;
  else if (t.tokenPlacement === 'query' && t.tokenParam) { const u = new URL(url); u.searchParams.set(t.tokenParam, t.token); url = u.toString(); }
  else if (t.tokenPlacement === 'body' && t.tokenParam) bodyObj[t.tokenParam] = t.token;

  const renderedPayload = JSON.stringify(bodyObj);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let result: FireResult;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: renderedPayload, signal: ctrl.signal });
    const snippet = (await res.text().catch(() => '')).slice(0, 2000);
    result = { ok: res.ok, httpStatus: res.status, responseSnippet: snippet, error: res.ok ? null : `HTTP ${res.status}`, renderedPayload, unresolved };
  } catch (e) {
    result = { ok: false, httpStatus: null, responseSnippet: null, error: e instanceof Error ? e.message : String(e), renderedPayload, unresolved };
  } finally { clearTimeout(timer); }

  await recordFire(pool, { tenantId: args.tenantId, triggerId: args.triggerId, source: args.source, vars: args.vars ?? {},
    httpStatus: result.httpStatus, ok: result.ok, responseSnippet: result.responseSnippet, error: result.error, createdBy: args.userId ?? null });
  await touchLastFired(pool, args.tenantId, args.triggerId);
  return result;
}
