# Per-Tenant Client Context (de-ABSA) — Design (v1)

**Date:** 2026-06-04
**Status:** Approved design — ready for implementation planning.
**Builds on:** the line-reporting/handover/chat stack. Every prompt-builder already loads `getLineReportConfig(pool, tenantId)` in scope (`lineCompose.ts`, `lineTagger.ts`, `handoverExtract.ts`, `handoverSend.ts`), so client fields are injectable without new lookups.

## Problem

"ABSA" and "bank client" are hardcoded across Abe's prompts, the handover email subject, the chat tool descriptions, and the web UI — plus the default taxonomy is 8 ABSA-banking categories. That context belongs to **First Assist only**; every other tenant should be generic.

## Approach

Add a per-tenant **client profile** — `client_name` + `client_context` — on `line_report_configs`. A small helper turns it into prompt phrasing with generic fallbacks, threaded through every hardcoded site. New tenants start with **no default categories** (Abe derives them per the self-setup feature). First Assist's profile is set to ABSA; everyone else reads generically.

## Data model — migration `1700000000029_client_profile.cjs`

Add to `line_report_configs`: `client_name text` (nullable), `client_context text` (nullable). Repo (`lineReportConfigs.ts`): add `client_name`/`client_context` to `LineReportConfigRow`; `clientName?`/`clientContext?` to `LineReportConfigPatch`; thread through `upsertLineReportConfig` **mirroring the existing `brand_voice` handling exactly** (same nullable-text-from-settings pattern). Also change the INSERT default for `taxonomy` from `DEFAULT_TAXONOMY` to `'[]'::jsonb` (new tenants start empty; existing rows untouched).

## Helper — `server/src/agent/abe/clientContext.ts` (new)

```ts
import type { LineReportConfigRow } from '../../repos/lineReportConfigs.js';
// label for inline substitution ("Callback for {label}", "update for {label}")
export function clientLabel(cfg: { client_name?: string | null } | null | undefined): string {
  return cfg?.client_name?.trim() || 'the client';
}
// an injectable block for system prompts (empty string when nothing configured)
export function clientPromptBlock(cfg: { client_name?: string | null; client_context?: string | null } | null | undefined): string {
  const name = cfg?.client_name?.trim();
  const ctx = cfg?.client_context?.trim();
  if (!name && !ctx) return '';
  const who = name ? `You are reporting to ${name}.` : 'You are reporting to the client who runs this line.';
  return ctx ? `${who} About this line: ${ctx}` : who;
}
```

## Genericize every hardcoded site (config is already in scope at each)

- **`lineCompose.ts`** — `ADVISORY_INSTRUCTIONS` line 12 "for the client (ABSA)" → "for the client"; thread `clientName`/`clientContext` from each compose function's loaded `cfg` into `runCompose`, and add `clientPromptBlock(cfg)` as a third element of the `system` array (lines 74-79). Context labels: line 158 "Write the {period} ABSA call-line update" → `...${clientLabel} call-line update`; line 188 "spike heads-up for ABSA" → `...for ${clientLabel}`; line 215 "Escalate this individual call to ABSA" → `...to ${clientLabel}`; line 235 "Question from ABSA:" → `Question from ${clientLabel}:`.
- **`lineTagger.ts`** — line 21 "for a bank client report" → "for the client's call-line report" (drop "bank"); `cfg` is loaded at line 12. (Client name not essential here; just de-bank it. Optionally append `clientPromptBlock(cfg)`.)
- **`handoverExtract.ts`** — line 21 "to a bank client (ABSA)" → `to ${clientLabel(cfg)}` (cfg loaded line 12); line 75 dismissReason "no ABSA follow-up needed" → "no follow-up needed".
- **`handoverSend.ts`** — line 19 subject "Callback for ABSA — …" → `Callback for ${clientLabel(cfg)} — …` (cfg loaded line 52).
- **`lineChatTools.ts`** — static TOOLS descriptions (lines 25, 40): "Recent ABSA reports" → "Recent client reports"; "Draft an ABSA report" → "Draft a client report (digest/answer). Creates a pending_approval draft; never sends." (Keep static/generic — the real client name flows through the report content; making per-tenant descriptions is out of scope.)
- **Chat system prompt** — `prompt.ts::buildAbeSystemPrompt(brandVoice)` → `buildAbeSystemPrompt(brandVoice, clientName?, clientContext?)`: append a client block (reuse `clientPromptBlock`-style text) after the brand-voice line when set. `chat.ts` (line 30): load the line-report config in `runAbeChat` (it already has `tenantId`) and pass `cfg?.client_name`/`cfg?.client_context` into `buildAbeSystemPrompt`.

## Web

- **`web/src/lib/abe.ts`** — add `client_name: string | null` + `client_context: string | null` to the `LineReportConfig` interface (so components reading `getLineSettings()` see them); `putLineSettings` body accepts `clientName`/`clientContext`.
- **`server/src/routes/lineReports.ts`** — `SettingsBody` zod: add `clientName: z.string().max(200).trim().nullable().optional()`, `clientContext: z.string().max(2000).trim().nullable().optional()`. GET/PUT already pass the full config.
- **`LineReportingSettings.tsx`** — add **"Client name"** (text) and **"Client / line context"** (textarea, hint: *"A short note on who you report to and what this line is — Abe uses it to tailor his analysis and drafts."*) to the form; include in the PUT.
- **`AbeHome.tsx`** (lines 14, 42, 60-61) and **`AbeChat.tsx`** (line 142) — replace literal "ABSA" with the client name from `getLineSettings()` config, falling back to **"your client"** when unset (e.g. "Needs setup before he can send to your client", "writes to your client (ABSA)" → "writes to your client" / "writes to {name}", "draft an update for {name||'your client'}").

## Deploy data step

Set First Assist's `client_name = 'ABSA'` and a `client_context` (e.g. "First Assist fields overflow calls for ABSA's iDirect line; we forward caller details to ABSA and report on call patterns.") on prod (authorized write). Every other tenant stays null → generic.

## Safety

- `client_context` is admin-set and injected like the existing `brand_voice` (same trust level); call content stays fenced as DATA.
- Generic fallbacks everywhere — an unconfigured tenant never emits "ABSA" or "bank".
- Categories-default → empty affects only NEW config rows; existing taxonomies (First Assist's) are untouched. `ensureCategories`/self-setup fills new tenants from their own calls.

## Testing

- **Repo:** `client_name`/`client_context` round-trip (set/preserve), mirroring brand_voice.
- **Helper:** `clientLabel`/`clientPromptBlock` — name set, name+context, neither (fallbacks).
- **Prompts (no live LLM needed):** call each builder with a stub LLM and a config that has `client_name='ABSA'` → assert the prompt/subject contains "ABSA" and NOT "bank"; with an empty config → assert it contains "the client"/"your client" and NEVER "ABSA". (handoverSend subject; tagger/handover/compose system strings can be asserted by capturing the stub's received messages.)
- **Default taxonomy:** a fresh config (no taxonomy passed) now has `taxonomy = []`; update the line-report tests that relied on the seeded default (`lineReport.tagger.test.ts`, `lineReport.shift.test.ts`, etc.) to set taxonomy explicitly.
- **Chat:** `buildAbeSystemPrompt('', 'ABSA', 'ctx')` includes ABSA + ctx; `buildAbeSystemPrompt('')` has neither.
- **Web:** `cd web && npm run build` + `tsc --noEmit`.

## Out of scope (v1)

Per-tenant industry templates; multiple clients per tenant; making chat tool descriptions per-tenant; rewriting already-sent reports/emails (historical).
