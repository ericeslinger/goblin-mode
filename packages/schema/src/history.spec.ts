import { describe, expect, it } from 'vitest';
import { HISTORY_INTERVAL_MS, keepReason } from './history';

const t0 = 1_800_000_000_000;
const v = (body: string, deviceId = 'd1', updatedBy: 'user' | 'claude' = 'user') => ({
  body,
  deviceId,
  updatedBy,
});

describe('keepReason', () => {
  it('keeps nothing for an empty version or a write that leaves the body alone', () => {
    expect(keepReason(v(''), v('typed', 'd2'), t0, t0)).toBeNull();
    expect(keepReason(v('same'), v('same', 'd2'), t0, t0 + HISTORY_INTERVAL_MS)).toBeNull();
  });

  it('keeps what another device, or a restore, wrote over', () => {
    expect(keepReason(v('mine'), v('theirs', 'd2'), t0, t0)).toBe('device');
    expect(keepReason(v('mine'), v('older', 'd1~restore'), t0, t0)).toBe('device');
  });

  it('keeps what Claude wrote over, and what Eric wrote over Claude', () => {
    expect(keepReason(v('mine'), v('claude', 'd1', 'claude'), t0, t0)).toBe('author');
    expect(keepReason(v('claude', 'd1', 'claude'), v('mine'), t0, t0)).toBe('author');
  });

  it('keeps one version per ten minutes of the same writer typing', () => {
    expect(keepReason(v('a'), v('ab'), t0, t0 + HISTORY_INTERVAL_MS - 1)).toBeNull();
    expect(keepReason(v('a'), v('ab'), t0, t0 + HISTORY_INTERVAL_MS)).toBe('interval');
  });

  it('keeps a note that was deleted', () => {
    expect(keepReason(v('gone soon'), undefined, t0, t0)).toBe('deleted');
  });
});
