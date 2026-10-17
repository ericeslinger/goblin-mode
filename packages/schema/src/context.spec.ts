import { describe, expect, it } from 'vitest';
import { CONTEXT_MAX, contextForClaude } from './context';

describe('contextForClaude', () => {
  it('gives the text trimmed, and cuts a long one, saying so', () => {
    expect(contextForClaude('  Fish comes Wednesdays.\n')).toBe('Fish comes Wednesdays.');
    const long = contextForClaude('x'.repeat(CONTEXT_MAX + 10));
    expect(long).toBe(`${'x'.repeat(CONTEXT_MAX)}\n[cut at ${CONTEXT_MAX} characters]`);
  });
});
