export interface LaunchInput {
  companyKey: string; suid: string; name: string; phone: string;
  timezone: string; values: Record<string, unknown>;
}
export interface LaunchResult { ok: boolean; status: number; body: unknown }

const DEFAULT_BASE = 'https://dashboard-api.jobix.ai';

export async function launchCall(input: LaunchInput, baseUrl: string = DEFAULT_BASE): Promise<LaunchResult> {
  const res = await fetch(`${baseUrl}/v1/customer/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company_key: input.companyKey,
      customer_data: {
        main: { suid: input.suid, name: input.name, phone: input.phone, timezone: input.timezone },
        values: input.values,
      },
    }),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

export type LaunchFn = (input: LaunchInput) => Promise<LaunchResult>;
