export function clientLabel(cfg: { client_name?: string | null } | null | undefined): string {
  return cfg?.client_name?.trim() || 'the client';
}
export function clientPromptBlock(
  cfg: { client_name?: string | null; client_context?: string | null } | null | undefined,
): string {
  const name = cfg?.client_name?.trim();
  const ctx = cfg?.client_context?.trim();
  if (!name && !ctx) return '';
  const who = name ? `You are reporting to ${name}.` : 'You are reporting to the client who runs this line.';
  return ctx ? `${who} About this line: ${ctx}` : who;
}
