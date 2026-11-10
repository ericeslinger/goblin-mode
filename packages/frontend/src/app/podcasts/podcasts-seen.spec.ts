import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { NOW } from '../platform/platform';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { FakeItems } from '../testing/fakes';
import { LATEST_SEEN_KEY, PodcastsSeen } from './podcasts-seen';

const NOW_MS = Date.parse('2026-11-10T12:00:00Z');
const H = 3_600_000;
const ep = (id: string, hoursAgo: number, more: Partial<ItemRecord> = {}): ItemRecord => ({
  id,
  feedId: 'p1',
  title: id,
  link: '',
  published: NOW_MS - hoursAgo * H,
  summary: '',
  content: '',
  read: false,
  saved: false,
  ...more,
});

function setup() {
  const items = new FakeItems();
  const user = signal<User | null | undefined>({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: ItemsService, useValue: items },
      { provide: AuthService, useValue: { user } },
      { provide: NOW, useValue: () => NOW_MS },
    ],
  });
  return { seen: TestBed.inject(PodcastsSeen), items, user };
}

describe('What is new in Podcasts (#251)', () => {
  beforeEach(() => localStorage.clear());

  it('counts the New episodes since Latest was seen, every one before the first visit', () => {
    const { seen, items } = setup();
    items.episodes.set([
      ep('a', 1),
      ep('b', 2, { read: true }),
      ep('c', 3, { position: 10 }),
      ep('d', 4, { played: true }),
    ]);
    expect(seen.fresh()).toBe(2);
    seen.markSeen();
    expect(seen.seenAt()).toBe(NOW_MS);
    expect(seen.fresh()).toBe(0);
    expect(JSON.parse(localStorage.getItem(LATEST_SEEN_KEY)!)).toEqual({ u1: NOW_MS });
    // One dated ahead by its feed's clock is seen too.
    items.episodes.set([ep('z', -2), ...items.episodes()]);
    expect(seen.fresh()).toBe(1);
    seen.markSeen();
    expect(seen.seenAt()).toBe(NOW_MS + 2 * H);
    expect(seen.fresh()).toBe(0);
  });

  it('writes nothing with no episodes or nothing newer, and keeps a mark per account', () => {
    const { seen, items, user } = setup();
    seen.markSeen();
    expect(localStorage.getItem(LATEST_SEEN_KEY)).toBeNull();
    items.episodes.set([ep('a', 1)]);
    seen.markSeen();
    const kept = localStorage.getItem(LATEST_SEEN_KEY);
    seen.markSeen();
    expect(localStorage.getItem(LATEST_SEEN_KEY)).toBe(kept);
    user.set({ uid: 'u2' } as User);
    expect(seen.seenAt()).toBeUndefined();
    expect(seen.fresh()).toBe(1);
  });

  it('reads the mark back on another start, and ignores what is not a number', () => {
    localStorage.setItem(LATEST_SEEN_KEY, JSON.stringify({ u1: NOW_MS - H, u2: 'soon' }));
    const { seen, items } = setup();
    items.episodes.set([ep('a', 2), ep('b', 0.5)]);
    expect(seen.seenAt()).toBe(NOW_MS - H);
    expect(seen.fresh()).toBe(1);
  });
});
