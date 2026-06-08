// Model used for high-volume, low-judgment batch call processing — tagging, classification,
// handover extraction, line-report tagging. Decoupled from the interactive Abe chat model
// (which stays on the tenant's configured model) so bulk work doesn't run on a premium model.
// gpt-4o-mini is ~15-20x cheaper than gpt-4o and ample for classifying call summaries.
export const CALL_BATCH_MODEL = 'gpt-4o-mini';
