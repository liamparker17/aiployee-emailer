import { describe, it, expect } from 'vitest';
import { validateTriggerUrl } from '../src/jobix/validateTriggerUrl.js';

describe('validateTriggerUrl', () => {
  it('accepts the jobix https url', () => {
    expect(() => validateTriggerUrl('https://dashboard-api.jobix.ai/automation/trigger/webhook')).not.toThrow();
  });
  it('rejects http://', () => {
    expect(() => validateTriggerUrl('http://dashboard-api.jobix.ai/x')).toThrow();
  });
  it('rejects a non-url', () => {
    expect(() => validateTriggerUrl('not a url')).toThrow();
  });
  it('rejects localhost and private/link-local IPs', () => {
    for (const u of [
      'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x',
      'https://192.168.0.1/x', 'https://169.254.169.254/x', 'https://172.16.0.1/x',
    ]) {
      expect(() => validateTriggerUrl(u), u).toThrow();
    }
  });
  it('accepts a normal public https host', () => {
    expect(() => validateTriggerUrl('https://example.com/hook')).not.toThrow();
  });
});
