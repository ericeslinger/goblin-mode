import { describe, expect, it } from 'vitest';
import { FRESH_NOTE_AFTER_MS, shouldStartFreshNote } from './launch';

describe('shouldStartFreshNote', () => {
  const now = 1_800_000_000_000;

  it('starts fresh when the app was never hidden', () => {
    expect(shouldStartFreshNote(undefined, now)).toBe(true);
  });

  it('resumes when away for less than five minutes', () => {
    expect(shouldStartFreshNote(now - FRESH_NOTE_AFTER_MS + 1, now)).toBe(false);
  });

  it('starts fresh at exactly five minutes', () => {
    expect(shouldStartFreshNote(now - FRESH_NOTE_AFTER_MS, now)).toBe(true);
  });

  it('resumes when the clock moved backwards', () => {
    expect(shouldStartFreshNote(now + 60_000, now)).toBe(false);
  });

  it('starts fresh on a corrupt stamp', () => {
    expect(shouldStartFreshNote(Number.NaN, now)).toBe(true);
  });
});
