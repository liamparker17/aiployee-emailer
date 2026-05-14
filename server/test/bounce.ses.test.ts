import { describe, it, expect } from 'vitest';
import { parseSesNotification } from '../src/webhooks/ses.js';

describe('parseSesNotification', () => {
  it('extracts permanent bounce recipients', () => {
    const msg = JSON.stringify({
      notificationType: 'Bounce',
      mail: { messageId: 'abc' },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'r@x.com' }] },
    });
    expect(parseSesNotification(msg)).toEqual({ type: 'bounce', messageId: 'abc', recipients: ['r@x.com'] });
  });

  it('ignores soft bounces', () => {
    const msg = JSON.stringify({
      notificationType: 'Bounce',
      mail: { messageId: 'abc' },
      bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'r@x.com' }] },
    });
    expect(parseSesNotification(msg)).toBeNull();
  });

  it('parses complaint events', () => {
    const msg = JSON.stringify({
      notificationType: 'Complaint',
      mail: { messageId: 'abc' },
      complaint: { complainedRecipients: [{ emailAddress: 'r@x.com' }] },
    });
    expect(parseSesNotification(msg)).toEqual({ type: 'complaint', messageId: 'abc', recipients: ['r@x.com'] });
  });

  it('parses delivery events with empty recipients', () => {
    const msg = JSON.stringify({
      notificationType: 'Delivery',
      mail: { messageId: 'abc' },
    });
    expect(parseSesNotification(msg)).toEqual({ type: 'delivery', messageId: 'abc', recipients: [] });
  });

  it('returns null when messageId missing', () => {
    const msg = JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [] } });
    expect(parseSesNotification(msg)).toBeNull();
  });
});
