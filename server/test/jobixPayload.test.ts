import { describe, it, expect } from 'vitest';
import { parseDurationSeconds } from '../src/agent/abe/jobixPayload.js';
import { normalizeCall } from '../src/agent/abe/jobixPayload.js';

describe('parseDurationSeconds', () => {
  it('parses "3 minutes 42 seconds" to 222', () => {
    expect(parseDurationSeconds('3 minutes 42 seconds')).toBe(222);
  });
  it('parses minutes-only and seconds-only', () => {
    expect(parseDurationSeconds('5 minutes')).toBe(300);
    expect(parseDurationSeconds('45 seconds')).toBe(45);
  });
  it('returns null for missing/garbage', () => {
    expect(parseDurationSeconds(undefined)).toBeNull();
    expect(parseDurationSeconds('')).toBeNull();
    expect(parseDurationSeconds('soon')).toBeNull();
  });
});

describe('normalizeCall', () => {
  it('extracts caller identity + outcome from customer_data shape', () => {
    const body = {
      company_key: 'V7E-...',
      customer_data: {
        main: { suid: 's1', name: 'Renier Jacobs', phone: '+27609381283', timezone: 'Africa/Johannesburg' },
        values: { type: 'Seller', call_summary: 'wants to sell', call_outcome: 'completed', sentiment: 'positive' },
      },
    };
    const n = normalizeCall(body, {});
    expect(n.callerSuid).toBe('s1');
    expect(n.callerName).toBe('Renier Jacobs');
    expect(n.callerPhone).toBe('+27609381283');
    expect(n.callerTimezone).toBe('Africa/Johannesburg');
    expect(n.summary).toBe('wants to sell');
    expect(n.callOutcome).toBe('completed');
    expect(n.sentiment).toBe('positive');
    expect(n.values).toEqual(body.customer_data.values);
  });

  it('handles the flat shape and parses duration + flags', () => {
    const body = {
      suid: 's2', call_summary: 'test drive', call_outcome: 'completed',
      callback_requested: true, callback_preferred_time: '15 April 2026',
      escalation_requested: false, call_duration: '3 minutes 42 seconds',
    };
    const n = normalizeCall(body, {});
    expect(n.callerSuid).toBe('s2');
    expect(n.summary).toBe('test drive');
    expect(n.callbackRequested).toBe(true);
    expect(n.callbackPreferredTime).toBe('15 April 2026');
    expect(n.escalationRequested).toBe(false);
    expect(n.callDurationSeconds).toBe(222);
  });

  it('resolves attribution via attribution_map values_key', () => {
    const body = { customer_data: { main: { suid: 's3' }, values: { department: 'Maintenance' } } };
    const n = normalizeCall(body, { source: 'values_key', values_key: 'department' });
    expect(n.attributionLabel).toBe('Maintenance');
  });

  it('default attribution heuristic falls back through type/Call/call/context/call_purpose', () => {
    const body = { customer_data: { main: { suid: 's4' }, values: { context: 'abandoned deposit' } } };
    const n = normalizeCall(body, {});
    expect(n.attributionLabel).toBe('abandoned deposit');
    expect(n.callType).toBe('abandoned deposit');
  });

  it('missing fields are null, never throws', () => {
    const n = normalizeCall({}, {});
    expect(n.callerSuid).toBeNull();
    expect(n.summary).toBeNull();
    expect(n.callbackRequested).toBe(false);
    expect(n.values).toEqual({});
  });
});
