const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

// HTML comments may contain example placeholders (e.g. documentation at the top
// of a designer-provided template) — strip them before scanning for variables so
// those examples don't trigger lookups or errors.
function stripHtmlComments(text: string): string {
  return text.replace(HTML_COMMENT_RE, '');
}

export function extractVariables(text: string): string[] {
  const cleaned = stripHtmlComments(text);
  const seen = new Set<string>();
  for (const m of cleaned.matchAll(VAR_RE)) seen.add(m[1]);
  return [...seen];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// Render policy: missing variables substitute as the empty string (not an error).
// Webhook callers like Jobix may legitimately omit optional fields; we don't want
// the whole send to fail because one optional placeholder went unfilled.
export function render(template: string, vars: Record<string, string>, opts: { escape?: boolean } = {}): string {
  const escape = opts.escape !== false;
  const cleaned = stripHtmlComments(template);
  return cleaned.replace(VAR_RE, (_m, name: string) => {
    const raw = name in vars ? String(vars[name] ?? '') : '';
    return escape ? escapeHtml(raw) : raw;
  });
}
