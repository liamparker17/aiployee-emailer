const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function extractVariables(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) seen.add(m[1]);
  return [...seen];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function render(template: string, vars: Record<string, string>, opts: { escape?: boolean } = {}): string {
  const escape = opts.escape !== false;
  return template.replace(VAR_RE, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`missing variable: ${name}`);
    const v = String(vars[name]);
    return escape ? escapeHtml(v) : v;
  });
}
