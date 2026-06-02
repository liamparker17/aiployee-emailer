# Cron setup — Abe (+ existing send jobs)

The app has **no in-process scheduler**; all `/v1/cron/*` endpoints are externally triggered.
As of 2026-06-01 they are registered as **Vercel-native cron jobs** in `vercel.json` (`crons`).
The cron routes accept **both GET and POST**, so the external POST triggers (cron-job.org /
`curl`) still work as a manual fallback.

## How Vercel crons authenticate
Vercel invokes each `crons[].path` with a **GET** request and includes
`Authorization: Bearer $CRON_SECRET` **when the `CRON_SECRET` env var is set** on the project.
The app's `requireCronAuth` (`server/src/routes/cron.ts`) accepts `Authorization: Bearer <secret>`
or `X-Cron-Secret: <secret>`.

> ✅ **Required:** `CRON_SECRET` must be set in the Vercel project env (Production). Without it,
> Vercel won't send the bearer token and every job will 401. (Per memory this was previously
> "unverified" — confirm it's set.)

## Registered jobs (`vercel.json` → `crons`)

| Path (GET) | Purpose | Schedule (UTC) |
|---|---|---|
| `/v1/cron/process-queue` | Dispatch due/queued emails (incl. Abe's touch sends) | `* * * * *` (every min) |
| `/v1/cron/retry-failed` | Requeue failed/stuck sends | `*/10 * * * *` |
| `/v1/cron/abe-shift` | Abe's heartbeat: propose/auto-fire a play per enabled tenant | `0 8 * * *` (daily 08:00) |
| `/v1/cron/abe-touches` | Advance executing plays to their next due touch (auto-skips re-engaged) | `30 8 * * *` |
| `/v1/cron/abe-outcomes` | Roll up engagement; close attribution windows | `0 9 * * *` |
| `/v1/cron/line-report` | Abe Client Line Reporting: tag new calls, detect spikes, draft daily digests & cases for every enabled tenant | `0 6 * * *` (daily 06:00) |

## Plan / cost notes
- **Sub-daily schedules (e.g. `process-queue` every minute) require a Vercel plan that allows it**
  (Hobby is limited to once-per-day). On a team/Pro plan this is fine. If a deploy rejects the
  schedule, coarsen it (e.g. `*/2 * * * *`) or keep `process-queue`/`retry-failed` on your existing
  external scheduler and remove them from `crons`.
- If you ALSO have an external scheduler hitting these, double-runs are **safe** — `process-queue`
  claims due emails atomically (`FOR UPDATE SKIP LOCKED`) and the Abe jobs are idempotent — but
  redundant; pick one.

## Manual trigger (fallback / testing)
```
curl -X POST https://aiployee-emailer.vercel.app/v1/cron/abe-shift \
  -H "X-Cron-Secret: $CRON_SECRET"
```

## After deploy — verify
- Vercel project → **Settings → Cron Jobs** lists the 5 jobs.
- Trigger `abe-shift` once (button in the dashboard, or the curl above) and confirm a 200 +
  (for a tenant with an enabled goal, OpenAI key, default sender, and dormant contacts) a new play.
