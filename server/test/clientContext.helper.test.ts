import { describe, it, expect } from 'vitest';
import { clientLabel, clientPromptBlock } from '../src/agent/abe/clientContext.js';

describe('clientContext', () => {
  it('clientLabel falls back to a generic label', () => {
    expect(clientLabel({ client_name: 'ABSA' })).toBe('ABSA');
    expect(clientLabel({ client_name: '  ' })).toBe('the client');
    expect(clientLabel(null)).toBe('the client');
  });

  it('clientPromptBlock includes name + context, or empty when unset', () => {
    expect(clientPromptBlock({ client_name: 'ABSA', client_context: 'iDirect overflow' }))
      .toBe('You are reporting to ABSA. About this line: iDirect overflow');
    expect(clientPromptBlock({ client_name: 'ABSA' })).toBe('You are reporting to ABSA.');
    expect(clientPromptBlock(null)).toBe('');
    expect(clientPromptBlock({ client_name: null, client_context: null })).toBe('');
  });
});
