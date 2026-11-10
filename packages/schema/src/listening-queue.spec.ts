import { describe, expect, it } from 'vitest';
import {
  QUEUE_STEP,
  byQueue,
  isQueueOrder,
  needsRenumber,
  orderAfter,
  orderAt,
  orderBefore,
  orderBetween,
  renumber,
} from './listening-queue';
import { FeedItem } from './model';

const NOW = Date.parse('2026-11-10T12:00:00Z');

describe('the listening queue’s order (#249)', () => {
  it('appends a step after the last, never before now', () => {
    expect(orderAfter(undefined, NOW)).toBe(NOW);
    expect(orderAfter(NOW + 5000, NOW)).toBe(NOW + 5000 + QUEUE_STEP);
    // An old queue: the append is now, so two devices offline keep their order.
    expect(orderAfter(10, NOW)).toBe(NOW);
    expect(orderAfter(10, NOW + 1)).toBeGreaterThan(orderAfter(10, NOW));
  });

  it('puts Play next a step before the first', () => {
    expect(orderBefore(undefined, NOW)).toBe(NOW);
    expect(orderBefore(NOW, NOW + 99)).toBe(NOW - QUEUE_STEP);
  });

  it('drops between two neighbours at their midpoint', () => {
    expect(orderBetween(1000, 2000)).toBe(1500);
    expect(orderBetween(-3000, -1000)).toBe(-2000);
  });

  it('asks for a renumber once neighbours are too close', () => {
    expect(needsRenumber(1000, 2000)).toBe(false);
    expect(needsRenumber(1000, 1000)).toBe(true);
    expect(needsRenumber(NOW, NOW + 0.0001)).toBe(true);
    // Halving a step at a time reaches it in a few dozen drops, never a wrong order.
    let a = NOW;
    let b = NOW + QUEUE_STEP;
    let drops = 0;
    while (!needsRenumber(a, b)) {
      const mid = orderBetween(a, b);
      expect(mid).toBeGreaterThan(a);
      expect(mid).toBeLessThan(b);
      b = mid;
      drops++;
    }
    expect(drops).toBeGreaterThan(15);
  });

  it('renumbers a whole queue a step apart, the first in its place', () => {
    expect(renumber(3, 500)).toEqual([500, 500 + QUEUE_STEP, 500 + 2 * QUEUE_STEP]);
    expect(renumber(0, 500)).toEqual([]);
  });

  it('places by index: first, last, between, or undefined to renumber', () => {
    const others = [1000, 2000, 3000];
    expect(orderAt(others, 0, NOW)).toBe(0);
    expect(orderAt(others, 1, NOW)).toBe(1500);
    expect(orderAt(others, 3, NOW)).toBe(NOW);
    expect(orderAt(others, 9, NOW)).toBe(NOW);
    expect(orderAt([], 0, NOW)).toBe(NOW);
    expect(orderAt([1000, 1000.0001], 1, NOW)).toBeUndefined();
  });

  it('sorts ascending, ties by id, and knows a stored order', () => {
    const list = [
      { id: 'b', queue: 2 },
      { id: 'c', queue: 1 },
      { id: 'a', queue: 2 },
    ];
    expect([...list].sort(byQueue).map((e) => e.id)).toEqual(['c', 'a', 'b']);
    expect(isQueueOrder(NOW)).toBe(true);
    expect(isQueueOrder(-5.5)).toBe(true);
    expect(isQueueOrder('1')).toBe(false);
    expect(isQueueOrder(Infinity)).toBe(false);
    expect(isQueueOrder(NaN)).toBe(false);
  });

  it('is a finite number on the stored episode, absent when not queued', () => {
    const ts = { seconds: NOW / 1000, nanoseconds: 0 };
    const item = {
      feedId: 'f',
      title: 't',
      link: '',
      published: ts,
      summary: '',
      content: '',
      read: false,
      saved: false,
      createdAt: ts,
      updatedAt: ts,
    };
    expect(FeedItem.safeParse(item).success).toBe(true);
    expect(FeedItem.safeParse({ ...item, queue: NOW }).success).toBe(true);
    expect(FeedItem.safeParse({ ...item, queue: 'first' }).success).toBe(false);
    expect(FeedItem.safeParse({ ...item, queue: Infinity }).success).toBe(false);
  });
});
