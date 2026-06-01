/** v1 risk = audience size. (Hooks for future factors — new segment, send-volume — go here later.) */
export function scoreRisk(args: { audienceSize: number }): number {
  return args.audienceSize;
}

/** Auto-fire only when audience size is within the tenant's cap. Cap 0 => everything escalates. */
export function requiresApproval(audienceSize: number, autoFireMaxAudience: number): boolean {
  return audienceSize > autoFireMaxAudience;
}
