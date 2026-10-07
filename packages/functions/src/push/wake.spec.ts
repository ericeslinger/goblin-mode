import { describe, expect, it, vi } from 'vitest';
import { MAX_AHEAD_MS, type WakeQueue, wakeAt, wakeFor, wakeName, wakeUpcoming } from './wake';

const NOW = Date.parse('2026-10-07T20:00:00Z');
const queue = () => ({ enqueue: vi.fn<WakeQueue['enqueue']>(async () => undefined) });

describe('wakeFor', () => {
  it('queues a wake at a new push time, named by reminder and time', async () => {
    const q = queue();
    const at = NOW + 60_000;
    expect(await wakeFor(q, 'u1', 'r1', undefined, at, NOW)).toBe(true);
    expect(q.enqueue).toHaveBeenCalledWith('u1', 'r1', at, wakeName('u1', 'r1', at, at));
    // Moved (snoozed, or advanced by a claim): a new wake.
    expect(await wakeFor(q, 'u1', 'r1', at, at + 60_000, NOW)).toBe(true);
    expect(q.enqueue).toHaveBeenCalledTimes(2);
  });

  it('queues nothing when the push time is unchanged or gone', async () => {
    const q = queue();
    expect(await wakeFor(q, 'u1', 'r1', NOW, NOW, NOW)).toBe(false);
    expect(await wakeFor(q, 'u1', 'r1', NOW, undefined, NOW)).toBe(false);
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it('wakes a past push now, and hops toward one beyond a task’s reach', async () => {
    expect(wakeAt(NOW - 5_000, NOW)).toBe(NOW);
    const far = NOW + 2 * MAX_AHEAD_MS;
    expect(wakeAt(far, NOW)).toBe(NOW + MAX_AHEAD_MS);
    const q = queue();
    await wakeFor(q, 'u1', 'r1', undefined, far, NOW);
    expect(q.enqueue).toHaveBeenCalledWith('u1', 'r1', NOW + MAX_AHEAD_MS, expect.any(String));
  });

  it('names tasks the way Cloud Tasks allows', () => {
    expect(wakeName('u.1', 'r/1', 5, 6)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(wakeName('u1', 'r1', 5, 6)).not.toBe(wakeName('u1', 'r1', 5, 7));
  });
});

describe('wakeUpcoming', () => {
  it('queues each coming push under the name its write used', async () => {
    const q = queue();
    const at = NOW + 10 * 60_000;
    expect(await wakeUpcoming(q, [{ uid: 'u1', id: 'r1', nextFireAt: at }], NOW)).toBe(1);
    expect(q.enqueue).toHaveBeenCalledWith('u1', 'r1', at, wakeName('u1', 'r1', at, at));
  });
});
