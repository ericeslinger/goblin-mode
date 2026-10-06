import { describe, expect, it } from 'vitest';
import { autoId } from './ids';

describe('autoId', () => {
  it('makes 20 characters from the Firestore alphabet', () => {
    const id = autoId((b) => void crypto.getRandomValues(b));
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it('skips biased bytes rather than skewing the alphabet', () => {
    let call = 0;
    const id = autoId((b) => void b.fill(call++ === 0 ? 255 : 0));
    expect(id).toBe('A'.repeat(20));
  });
});
