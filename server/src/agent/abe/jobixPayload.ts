// Pure helpers for normalizing a Jobix post-call payload. No DB, no IO.

// "3 minutes 42 seconds" -> 222. Accepts minutes-only / seconds-only. null if unparseable.
export function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const m = raw.match(/(\d+)\s*min/i);
  const s = raw.match(/(\d+)\s*sec/i);
  if (!m && !s) return null;
  return (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
}
