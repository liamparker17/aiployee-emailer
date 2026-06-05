/**
 * send-test-calls.mjs
 * Developer utility — POSTs representative Jobix call payloads to POST /v1/jobix/calls
 * and prints each response.
 *
 * Configuration (env vars):
 *   API_KEY   REQUIRED. Bearer token for a tenant API key. Create one in the app's
 *             API Keys screen (Settings → API Keys). The script exits immediately if unset.
 *   BASE_URL  Base URL of the server (default: http://localhost:3000).
 *
 * Usage:
 *   node scripts/send-test-calls.mjs              # send all samples
 *   node scripts/send-test-calls.mjs mafadi       # send one sample by name
 *   API_KEY=xxx BASE_URL=https://preview.example.com node scripts/send-test-calls.mjs
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const API_KEY  = process.env.API_KEY;

if (!API_KEY) {
  console.error(
    'Error: API_KEY is required.\n' +
    'Create an API key in the app\'s API Keys screen (Settings → API Keys),\n' +
    'then run:\n' +
    '  API_KEY=<your-key> node scripts/send-test-calls.mjs'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Sample payloads
// ---------------------------------------------------------------------------

const SAMPLES = {
  /**
   * customer_data shape — property-management arrears call.
   * department: 'Accounts' (not Maintenance — arrears is a billing matter).
   */
  mafadi: {
    company_key: 'sky-place-pm',
    customer_data: {
      main: {
        suid:     'mafadi-test-001',
        name:     'Thembi Mafadi',
        phone:    '+27831234567',
        timezone: 'Africa/Johannesburg',
      },
      values: {
        full_name:    'Thembi Mafadi',
        unit_number:  '103',
        building_name:'Sky Place',
        arrears_amount: 2449.46,
        department:   'Accounts',
        call_summary: 'Tenant queried arrears balance and disputed a late fee.',
        call_outcome: 'completed',
        sentiment:    'neutral',
        call_duration:'4 minutes 12 seconds',
      },
    },
  },

  /**
   * customer_data shape — Weelee vehicle-seller enquiry.
   */
  'weelee-seller': {
    company_key: 'weelee',
    customer_data: {
      main: {
        suid:     'weelee-seller-test-001',
        name:     'Johan van der Berg',
        phone:    '+27729876543',
        timezone: 'Africa/Johannesburg',
      },
      values: {
        type:         'Seller',
        vehicle_make: 'Toyota',
        vehicle_model:'Corolla',
        call_summary: 'Seller wants to list their Corolla; asked about valuation.',
        call_outcome: 'completed',
        sentiment:    'positive',
        call_duration:'3 minutes 42 seconds',
      },
    },
  },

  /**
   * Flat post-call shape — buyer requested a callback about finance.
   */
  callback: {
    suid:                   'callback-test-001',
    call_summary:           'Buyer requested a callback about finance.',
    call_outcome:           'completed',
    callback_requested:     true,
    callback_preferred_time:'15 April 2026 10:00',
    escalation_requested:   false,
    call_duration:          '2 minutes 05 seconds',
  },

  /**
   * Flat post-call shape — escalated call.
   */
  escalation: {
    suid:                 'escalation-test-001',
    call_summary:         'Caller was irate about a missed delivery; requested to speak to a manager.',
    call_outcome:         'escalated',
    escalation_requested: true,
    callback_requested:   false,
    call_duration:        '5 minutes 33 seconds',
  },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const ENDPOINT = `${BASE_URL}/v1/jobix/calls`;
const HEADERS  = {
  'content-type': 'application/json',
  'authorization': `Bearer ${API_KEY}`,
};

/**
 * Send a single named sample and print the result.
 * @param {string} name
 * @param {object} body
 * @returns {Promise<boolean>} true if 2xx
 */
async function sendSample(name, body) {
  try {
    const res  = await fetch(ENDPOINT, {
      method:  'POST',
      headers: HEADERS,
      body:    JSON.stringify(body),
    });

    const text = await res.text();

    if (res.ok) {
      // Try to parse JSON for a nicer one-liner
      let extra = '';
      try {
        const json = JSON.parse(text);
        const parts = [];
        if (json.created    !== undefined) parts.push(`created=${json.created}`);
        if (json.message_id !== undefined) parts.push(`message_id=${json.message_id}`);
        if (json.id         !== undefined) parts.push(`id=${json.id}`);
        extra = parts.length ? '  ' + parts.join('  ') : '';
      } catch {
        extra = text ? `  ${text.slice(0, 120)}` : '';
      }
      console.log(`✓ ${name} -> ${res.status}${extra}`);
      return true;
    } else {
      console.error(`✗ ${name} -> ${res.status}  ${text.slice(0, 300)}`);
      return false;
    }
  } catch (err) {
    console.error(`✗ ${name} -> network error: ${err.message}`);
    return false;
  }
}

async function main() {
  const arg = process.argv[2];

  let toSend;
  if (arg) {
    if (!(arg in SAMPLES)) {
      console.error(
        `Unknown sample "${arg}". Available: ${Object.keys(SAMPLES).join(', ')}`
      );
      process.exit(1);
    }
    toSend = [[arg, SAMPLES[arg]]];
  } else {
    toSend = Object.entries(SAMPLES);
  }

  console.log(`Sending ${toSend.length} sample(s) to ${ENDPOINT}\n`);

  const results = [];
  for (const [name, body] of toSend) {
    results.push(await sendSample(name, body));
  }

  const allOk = results.every(Boolean);
  if (!allOk) {
    process.exit(1);
  }
}

main();
