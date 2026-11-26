import { TestBed } from '@angular/core/testing';
import { PENDING_SHARES_KEY, SHARE_WORDS, ShareStore } from './share-store';

const raw = (key: string, text = key) => ({ title: '', text, url: '', at: '', key });

/** Two windows on one device: two stores over the same localStorage. */
function twoWindows() {
  localStorage.clear();
  const remove = vi.fn(async (_stash: string) => undefined);
  TestBed.configureTestingModule({
    providers: [{ provide: SHARE_WORDS, useValue: { read: vi.fn(), remove } }],
  });
  const make = () => TestBed.runInInjectionContext(() => new ShareStore());
  return { a: make(), b: make(), remove };
}

const stored = () =>
  (JSON.parse(localStorage.getItem(PENDING_SHARES_KEY) ?? '[]') as { key: string }[]).map(
    (p) => p.key,
  );

describe('ShareStore', () => {
  it('reads the store afresh on every change, so two windows keep each other’s shares', () => {
    const { a, b } = twoWindows();
    a.take(raw('one'), { now: 1 });
    // b read the store before a took its share in; it must not write that back.
    b.take(raw('two'), { now: 2 });
    expect(stored()).toEqual(['one', 'two']);
    a.update('two', { recipeId: 'r1' });
    b.done('one');
    expect(stored()).toEqual(['two']);
    expect(b.pending()).toEqual([expect.objectContaining({ key: 'two', recipeId: 'r1' })]);
    // Taken in one window, a reload in the other knows it.
    b.done('two');
    expect(a.take(raw('one'), { now: 3 })).toBeUndefined();
  });

  it('lets one window at a time file a share, until it lets go or its claim runs out', () => {
    const { a, b } = twoWindows();
    a.take(raw('one'), { now: 1 });
    expect(a.claim('one', 10, 1000)).toBe(true);
    expect(b.claim('one', 20, 1000)).toBe(false);
    expect(b.heldElsewhere(b.pending()[0], 20)).toBe(true);
    a.release('one');
    expect(b.claim('one', 30, 1000)).toBe(true);
    // A claim from a window that went away runs out.
    expect(a.claim('one', 500, 1000)).toBe(false);
    expect(a.claim('one', 2000, 1000)).toBe(true);
    a.done('one');
    expect(b.claim('one', 2100, 1000)).toBe(false);
  });

  it('shows a share kept for one account to that account only, and one from signed out to all', () => {
    const { a } = twoWindows();
    a.take(raw('mine'), { now: 1, uid: 'u1' });
    a.take(raw('anyone'), { now: 2 });
    expect(a.visibleTo('u1').map((p) => p.key)).toEqual(['mine', 'anyone']);
    expect(a.visibleTo('u2').map((p) => p.key)).toEqual(['anyone']);
    expect(a.visibleTo(null).map((p) => p.key)).toEqual(['anyone']);
  });

  it('forgets stashed words once their share is filed', () => {
    const { a, remove } = twoWindows();
    a.take({ ...raw('at:5', ''), stash: '5' }, { now: 1 });
    expect(a.pending()[0]).toMatchObject({ stash: '5', text: '' });
    a.done('at:5');
    expect(remove).toHaveBeenCalledWith('5');
  });

  it('shares its storage key with nothing else (2026-11-26)', async () => {
    // The public copies' waiting writes once took this key and emptied
    // the shares waiting to be filed.
    const { PUBLIC_COPY_WRITES_KEY } = await import('../notes/notes.service');
    expect(PUBLIC_COPY_WRITES_KEY).not.toBe(PENDING_SHARES_KEY);
  });
});
