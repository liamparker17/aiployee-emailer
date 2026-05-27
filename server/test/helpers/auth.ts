import type { FastifyInstance } from 'fastify';

/** Obtains a CSRF cookie from GET /healthz and returns cookie string + token value. */
export async function csrfFor(app: FastifyInstance): Promise<{ cookie: string; csrfToken: string }> {
  const g = await app.inject({ method: 'GET', url: '/healthz' });
  const setCookie = g.headers['set-cookie'] as string | string[];
  const cookies = ([] as string[]).concat(setCookie).filter(Boolean);
  const csrfRaw = cookies.find(c => c.startsWith('aip_csrf='))!.split(';')[0];
  const csrfToken = decodeURIComponent(csrfRaw.split('=')[1]);
  return { cookie: csrfRaw, csrfToken };
}

/**
 * Logs in and returns full authenticated headers (aip_sid from login response + aip_csrf).
 * `csrf` is the result of `csrfFor(app)`.
 */
export async function login(
  app: FastifyInstance,
  credentials: { email: string; password: string },
  csrf: { cookie: string; csrfToken: string },
): Promise<{ cookie: string; 'x-csrf-token': string }> {
  const loginHeaders = { cookie: csrf.cookie, 'x-csrf-token': csrf.csrfToken };
  const r = await app.inject({
    method: 'POST', url: '/auth/login',
    headers: loginHeaders,
    payload: credentials,
  });
  const setCookie = r.headers['set-cookie'] as string | string[];
  const cookies = ([] as string[]).concat(setCookie).filter(Boolean);
  const sidRaw = cookies.find(c => c.startsWith('aip_sid='))!.split(';')[0];
  return { cookie: `${sidRaw}; ${csrf.cookie}`, 'x-csrf-token': csrf.csrfToken };
}
