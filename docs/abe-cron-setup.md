# Cron setup — Abe (+ existing send jobs)

The app has **no in-process scheduler**. All `/v1/cron/*` endpoints are triggered by an
**external cron service** (e.g. cron-job.org), the same way `process-queue`/`retry-failed`
already are. They are **POST** requests authenticated with the `CRON_SECRET`.

> Note: Vercel-native crons (`vercel.json` `crons`) are **not** used here — they issue `GET`,
> but these routes are `POST`. Keep using the external scheduler. (If you ever want
> Vercel-native crons, the routes would need `GET` handlers added.)

## Auth
Every request must include the secret, either header works (see `requireCronAuth` in
`server/src/routes/cron.ts`):
- `Authorization: Bearer <CRON_SECRET>`  — or —
- `X-Cron-Secret: <CRON_SECRET>`

Base URL (prod): `https://aiployee-emailer.vercel.app`

## Jobs to register

| Endpoint (POST) | Purpose | Suggested schedule |
|---|---|---|
| `/v1/cron/process-queue` | Dispatch due/queued emails (incl. Abe's touch sends) | every **1–2 min** |
| `/v1/cron/retry-failed` | Requeue failed/stuck sends | every **10 min** |
| `/v1/cron/abe-shift` | Abe's heartbeat: scan dormant contacts → propose/auto-fire a play per enabled tenant | **daily** (e.g. 08:00) |
| `/v1/cron/abe-touches` | Advance executing plays to their next due touch (auto-skips re-engaged contacts) | **daily** (e.g. 08:15) — or hourly for tighter timing |
| `/v1/cron/abe-outcomes` | Roll up engagement (opens/clicks/reactivations) per play; close attribution windows | **daily** (e.g. 09:00) |

Notes:
- `abe-touches` only sends a touch when it's due (`executed_at + touchIndex × touch_spacing_days`),
  so daily is sufficient; run hourly only if you want touches to go out closer to their exact due time.
- `abe-shift`/`abe-touches`/`abe-outcomes` are no-ops for tenants without an enabled goal / configured
  OpenAI key / default sender, so it's safe to run them across all tenants on one schedule.
- Touch emails are merely **queued** by `abe-touches`; they actually send via `process-queue`, so keep
  that job running frequently.

## Example (cron-job.org / curl)
```
curl -X POST https://aiployee-emailer.vercel.app/v1/cron/abe-shift \
  -H "X-Cron-Secret: $CRON_SECRET"
```

## Verify CRON_SECRET is set in prod
The endpoints 401 without the secret. Confirm `CRON_SECRET` is configured in the Vercel
project env (it powers all five jobs above).
