# scripts/

Developer utility scripts for the Aiployee emailer repo.

---

## Sending test calls

`send-test-calls.mjs` POSTs representative Jobix call payloads to `POST /v1/jobix/calls`
so you can exercise the webhook without a live Jobix integration.

**Prerequisites:** Node 18+ (uses the built-in `fetch` global). No npm install needed.

**Config:**

| Env var    | Required | Default                 | Notes                                                                                              |
|------------|----------|-------------------------|----------------------------------------------------------------------------------------------------|
| `API_KEY`  | Yes      | —                       | Bearer token for a tenant API key. Create one in the app → Settings → API Keys.                   |
| `BASE_URL` | No       | `http://localhost:3000` | Override to point at a preview or prod URL, e.g. `https://your-preview.vercel.app`.               |

**Usage:**

```bash
# Send all four samples
API_KEY=<your-key> node scripts/send-test-calls.mjs

# Send a single sample by name
API_KEY=<your-key> node scripts/send-test-calls.mjs mafadi

# Available sample names:
#   mafadi         customer_data shape — property-management arrears call
#   weelee-seller  customer_data shape — vehicle-seller enquiry
#   callback       flat shape — buyer requested a callback
#   escalation     flat shape — escalated call

# Target a preview or prod URL
API_KEY=<your-key> BASE_URL=https://<preview-url>.vercel.app node scripts/send-test-calls.mjs
```

**Exit codes:** 0 if all sent samples returned 2xx; non-zero otherwise.

---

## Other scripts

| Script                 | Purpose                                                |
|------------------------|--------------------------------------------------------|
| `bootstrap-dev.sh`     | Set up the local dev environment (Linux / macOS / WSL) |
| `bootstrap-dev.ps1`    | Set up the local dev environment (Windows PowerShell)  |
