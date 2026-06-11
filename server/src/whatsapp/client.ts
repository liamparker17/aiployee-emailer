// Thin HTTP client for the Aiployee WhatsApp platform Public API (v1).
// Contract per the platform's Postman collection: bearer auth, JSON bodies,
// optional Idempotency-Key header on POST /api/v1/messages.

export interface WaConnectionForSend {
  id: string;
  tenantId: string;
  baseUrl: string;
  apiKey: string;
  fromNumber: string | null;
  active: boolean;
}

export interface WaSendArgs {
  to: string;
  text?: string;
  template?: { name: string; language: string };
  from?: string | null;
  idempotencyKey?: string;
}

export interface WaApiResult {
  ok: boolean;
  status: number | null;
  body: unknown;
  snippet: string | null;
  error: string | null;
}

export async function waSendMessage(conn: WaConnectionForSend, args: WaSendArgs): Promise<WaApiResult> {
  const body: Record<string, unknown> = { channel: 'whatsapp', to: args.to };
  if (args.template) {
    body.kind = 'template';
    body.template_name = args.template.name;
    body.language = args.template.language;
  } else {
    body.message = args.text ?? '';
  }
  const from = args.from ?? conn.fromNumber;
  if (from) body.from = from;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${conn.apiKey}`,
  };
  if (args.idempotencyKey) headers['Idempotency-Key'] = args.idempotencyKey;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${conn.baseUrl}/api/v1/messages`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON response */ }
    return { ok: res.ok, status: res.status, body: parsed, snippet: text.slice(0, 2000), error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: null, body: null, snippet: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
