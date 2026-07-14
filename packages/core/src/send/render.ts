const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const IF_RE = /\{\{\s*#if\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}([\s\S]*?)\{\{\s*\/if\s*\}\}/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

// Values that read as "empty" for a {{#if}} block. The webhook sends an LLM's
// booleans/enums stringified ("false", "none", ""), so a JS truthiness check is
// wrong ("false" is a truthy string) — collapse the block on this explicit set.
const FALSY_VALUES = new Set(['', 'none', 'false', 'no', 'null', 'undefined', '0', 'n/a', '-']);

function isFalsy(v: string | undefined): boolean {
  return FALSY_VALUES.has(String(v ?? '').trim().toLowerCase());
}

// Non-nested {{#if name}}…{{/if}} sections: keep the body only when the variable
// is present and not falsy. Runs before variable substitution so {{ vars }} inside
// a kept block still resolve.
function applyConditionals(text: string, vars: Record<string, string>): string {
  return text.replace(IF_RE, (_m, name: string, body: string) => (isFalsy(vars[name]) ? '' : body));
}

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
  const cleaned = applyConditionals(stripHtmlComments(template), vars);
  return cleaned.replace(VAR_RE, (_m, name: string) => {
    const raw = name in vars ? String(vars[name] ?? '') : '';
    return escape ? escapeHtml(raw) : raw;
  });
}
