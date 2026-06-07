import { describe, it, expect, vi, afterEach } from 'vitest';
import { launchCall } from '../src/jobix/launchClient.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('launchCall', () => {
  it('POSTs the customer/save payload and returns ok on 2xx', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await launchCall({ companyKey: 'ck', suid: 's1', name: 'R', phone: '+2760', timezone: 'Africa/Johannesburg', values: { unit_number: '103' } });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dashboard-api.jobix.ai/v1/customer/save');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      company_key: 'ck',
      customer_data: { main: { suid: 's1', name: 'R', phone: '+2760', timezone: 'Africa/Johannesburg' }, values: { unit_number: '103' } },
    });
  });

  it('returns ok=false on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 422 })));
    const res = await launchCall({ companyKey: 'ck', suid: 's1', name: 'R', phone: '+2760', timezone: 'UTC', values: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(422);
  });
});
