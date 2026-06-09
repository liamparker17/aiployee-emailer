function csrfTokenFromCookie(): string {
  const m = document.cookie.match(/(?:^|;\s*)aip_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((opts.headers as Record<string, string>) ?? {}),
  };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (opts.method && !['GET', 'HEAD'].includes(opts.method.toUpperCase())) {
    headers['X-CSRF-Token'] = csrfTokenFromCookie();
  }
  const res = await fetch(path, { credentials: 'include', ...opts, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const code = body?.error?.code ?? 'http_' + res.status;
    const message = body?.error?.message ?? res.statusText;
    throw Object.assign(new Error(message), { code, status: res.status, details: body?.error?.details });
  }
  return body as T;
}
