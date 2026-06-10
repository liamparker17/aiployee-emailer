// Model used for high-volume, low-judgment batch call processing — tagging, classification,
// handover extraction, line-report tagging. Decoupled from the interactive Abe chat model
// (which stays on the tenant's configured model) so bulk work doesn't run on a premium model.
// gpt-4o-mini is ~15-20x cheaper than gpt-4o and ample for classifying call summaries.
// Models are FIXED per role — tenants paste an OpenAI key and the platform
// spends it as efficiently as possible; there is no per-tenant model choice.

// Orchestration / reasoning: Abe chat, shift planning, and the Jobix response
// agent's tool loop. The only role that earns a premium model.
export const ABE_CHAT_MODEL = 'gpt-4.1';

export const CALL_BATCH_MODEL = 'gpt-4o-mini';

// Inbox reply analysis (cluster labeling, hot-lead scan, draft personalisation).
// Bulk reply text only ever touches embeddings; this chat model sees small
// samples/snippets, so the cheapest tier is ample. gpt-4.1-nano is ~3x cheaper
// than gpt-4o-mini.
export const INBOX_BATCH_MODEL = 'gpt-4.1-nano';
