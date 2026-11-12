import { KEPT_SETTINGS_KEY, keepUntilAcknowledged, mergeFields } from './kept-settings';
import type { SettingsApi } from './theme-sync.service';

/** localStorage as a map; `refuse` makes every call throw, as a full or blocked one does. */
class MemoryStorage implements Storage {
  readonly items = new Map<string, string>();
  refuse = false;
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  key(i: number): string | null {
    return [...this.items.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    if (this.refuse) throw new Error('refused');
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.refuse) throw new Error('refused');
    this.items.set(k, v);
  }
  removeItem(k: string): void {
    if (this.refuse) throw new Error('refused');
    this.items.delete(k);
  }
}

const DB = {} as never;
const APP = 'users/u1/settings/app';
const ASSISTANT = 'users/u1/settings/assistant';

/** The Firestore seam underneath, its writes settled by hand. */
function inner() {
  const order: string[] = [];
  const writes: {
    path: string;
    data: Record<string, unknown>;
    merge?: boolean;
    done: () => void;
    fail: (err: unknown) => void;
  }[] = [];
  let stamps = 0;
  const api = {
    listen: vi.fn((_db: unknown, path: string) => {
      order.push(`listen ${path}`);
      return () => undefined;
    }),
    set: vi.fn(
      (_db: unknown, path: string, data: Record<string, unknown>, merge?: boolean) =>
        new Promise<void>((done, fail) => {
          order.push(`set ${path}`);
          writes.push({ path, data, merge, done, fail });
        }),
    ),
    // A fresh object each time, as serverTimestamp() is.
    now: () => ({ serverTime: ++stamps }),
  } satisfies SettingsApi;
  return { api, writes, order };
}

function setup(storage: Storage | null = new MemoryStorage()) {
  const under = inner();
  return { ...under, kept: keepUntilAcknowledged(under.api, storage), storage };
}

const stored = (s: Storage | null, path: string) => {
  const raw = s?.getItem(`${KEPT_SETTINGS_KEY}.${path}`);
  return raw ? JSON.parse(raw) : undefined;
};

/** Lets the settle handlers run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('keepUntilAcknowledged (#224)', () => {
  it('keeps a write at once, the server time as a marker, and forgets it once acknowledged', async () => {
    const { kept, writes, storage } = setup();
    const written = kept.set(DB, APP, { theme: 'bog', mode: 'light', updatedAt: kept.now() });
    expect(writes[0].data).toEqual({ theme: 'bog', mode: 'light', updatedAt: { serverTime: 1 } });
    expect(stored(storage, APP)).toEqual({
      seq: expect.any(Number),
      merge: false,
      data: { theme: 'bog', mode: 'light', updatedAt: { 'goblin.serverTime': true } },
    });
    writes[0].done();
    await written;
    await settle();
    expect(stored(storage, APP)).toBeUndefined();
  });

  it('forgets a refused write too, and hands the refusal on', async () => {
    const { kept, writes, storage } = setup();
    const written = kept.set(DB, APP, { theme: 'bog' });
    writes[0].fail(new Error('permission-denied'));
    await expect(written).rejects.toThrow('permission-denied');
    await settle();
    expect(stored(storage, APP)).toBeUndefined();
  });

  it('gathers merge writes to one doc, maps merged field by field, a later field winning', () => {
    const { kept, storage } = setup();
    void kept.set(DB, ASSISTANT, { digest: { push: true, timeZone: 'UTC' } }, true);
    void kept.set(DB, ASSISTANT, { digest: { hour: 21, timeZone: 'Europe/Paris' } }, true);
    void kept.set(DB, ASSISTANT, { gardenOnArrival: true, arrivalSkip: { tags: ['a'] } }, true);
    void kept.set(DB, ASSISTANT, { arrivalSkip: { tags: ['b'] } }, true);
    expect(stored(storage, ASSISTANT)).toMatchObject({
      merge: true,
      data: {
        digest: { push: true, hour: 21, timeZone: 'Europe/Paris' },
        gardenOnArrival: true,
        arrivalSkip: { tags: ['b'] },
      },
    });
  });

  it('a whole write replaces what was kept, and stays whole under later merges', () => {
    const { kept, storage } = setup();
    void kept.set(DB, APP, { theme: 'bog', startOn: 'home' }, true);
    void kept.set(DB, APP, { theme: 'moss', mode: 'dark' });
    expect(stored(storage, APP)).toMatchObject({
      merge: false,
      data: { theme: 'moss', mode: 'dark' },
    });
    void kept.set(DB, APP, { mode: 'light' }, true);
    expect(stored(storage, APP)).toMatchObject({
      merge: false,
      data: { theme: 'moss', mode: 'light' },
    });
  });

  it('an earlier write settling leaves a later one kept; the latest settling forgets it', async () => {
    const { kept, writes, storage } = setup();
    void kept.set(DB, APP, { theme: 'bog' });
    void kept.set(DB, APP, { theme: 'moss' });
    writes[0].done();
    await settle();
    expect(stored(storage, APP)).toMatchObject({ data: { theme: 'moss' } });
    // One more after the first settled, then the second settles: still kept.
    void kept.set(DB, APP, { theme: 'pixel' });
    writes[1].fail(new Error('offline'));
    await settle();
    expect(stored(storage, APP)).toMatchObject({ data: { theme: 'pixel' } });
    writes[2].done();
    await settle();
    expect(stored(storage, APP)).toBeUndefined();
  });

  it('writes what an earlier load left before listening, the same way, a fresh server time', async () => {
    const storage = new MemoryStorage();
    const first = setup(storage);
    void first.kept.set(
      DB,
      ASSISTANT,
      { digest: { push: true }, updatedAt: first.kept.now() },
      true,
    );
    // The page reloads before the write settles.
    const { kept, writes, order, api } = setup(storage);
    const stop = vi.fn();
    api.listen.mockImplementation((_db: unknown, path: string) => {
      order.push(`listen ${path}`);
      return stop;
    });
    expect(kept.listen(DB, ASSISTANT, vi.fn(), vi.fn())).toBe(stop);
    expect(order).toEqual([`set ${ASSISTANT}`, `listen ${ASSISTANT}`]);
    expect(writes[0]).toMatchObject({
      path: ASSISTANT,
      merge: true,
      data: { digest: { push: true }, updatedAt: { serverTime: 1 } },
    });
    // Kept until the replay settles, then forgotten.
    expect(stored(storage, ASSISTANT)).toMatchObject({ data: { digest: { push: true } } });
    writes[0].done();
    await settle();
    expect(stored(storage, ASSISTANT)).toBeUndefined();
  });

  it('drops a record the write throws on, and still listens (review on #259)', () => {
    const storage = new MemoryStorage();
    const first = setup(storage);
    void first.kept.set(DB, APP, { theme: 'bog', updatedAt: first.kept.now() });
    // The page reloads; the SDK refuses the kept data outright, by throwing.
    const { kept, api, order } = setup(storage);
    api.set.mockImplementationOnce(() => {
      throw new Error('unsupported field value');
    });
    const stop = vi.fn();
    api.listen.mockImplementation((_db: unknown, path: string) => {
      order.push(`listen ${path}`);
      return stop;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(kept.listen(DB, APP, vi.fn(), vi.fn())).toBe(stop);
    expect(order).toEqual([`listen ${APP}`]);
    expect(stored(storage, APP)).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('replays once a load, and never a doc already written in this one', () => {
    const storage = new MemoryStorage();
    void setup(storage).kept.set(DB, APP, { theme: 'bog' });
    void setup(storage).kept.set(DB, ASSISTANT, { gardenOnArrival: true }, true);
    const { kept, writes } = setup(storage);
    kept.listen(DB, APP, vi.fn(), vi.fn());
    kept.listen(DB, APP, vi.fn(), vi.fn());
    expect(writes.map((w) => w.path)).toEqual([APP]);
    // Written here before it is listened to: what is kept is this load's own.
    void kept.set(DB, ASSISTANT, { gardenOnArrival: false }, true);
    kept.listen(DB, ASSISTANT, vi.fn(), vi.fn());
    expect(writes.map((w) => w.data)).toEqual([{ theme: 'bog' }, { gardenOnArrival: false }]);
  });

  it('leaves another account’s kept write alone', () => {
    const storage = new MemoryStorage();
    void setup(storage).kept.set(DB, APP, { theme: 'bog' });
    const { kept, writes } = setup(storage);
    kept.listen(DB, 'users/u2/settings/app', vi.fn(), vi.fn());
    expect(writes).toEqual([]);
    expect(stored(storage, APP)).toMatchObject({ data: { theme: 'bog' } });
  });

  it('changes nothing when nothing is kept', () => {
    const { kept, writes, order } = setup();
    kept.listen(DB, APP, vi.fn(), vi.fn());
    expect(writes).toEqual([]);
    expect(order).toEqual([`listen ${APP}`]);
  });

  it('writes as before when storage is missing, refused or holds something else', async () => {
    for (const storage of [null, Object.assign(new MemoryStorage(), { refuse: true })]) {
      const { kept, writes, order } = setup(storage);
      const written = kept.set(DB, APP, { theme: 'bog' });
      expect(writes).toHaveLength(1);
      kept.listen(DB, APP, vi.fn(), vi.fn());
      expect(order).toEqual([`set ${APP}`, `listen ${APP}`]);
      writes[0].done();
      await expect(written).resolves.toBeUndefined();
    }
    const garbled = new MemoryStorage();
    garbled.setItem(`${KEPT_SETTINGS_KEY}.${APP}`, '{not json');
    garbled.setItem(`${KEPT_SETTINGS_KEY}.${ASSISTANT}`, JSON.stringify({ theme: 'bog' }));
    const { kept, writes } = setup(garbled);
    kept.listen(DB, APP, vi.fn(), vi.fn());
    kept.listen(DB, ASSISTANT, vi.fn(), vi.fn());
    expect(writes).toEqual([]);
  });

  it('keeps no write holding a value JSON would change, and drops the older one kept', () => {
    const { kept, writes, storage } = setup();
    void kept.set(DB, APP, { theme: 'bog' });
    class Stamp {
      toMillis = () => 1;
    }
    void kept.set(DB, APP, { theme: 'moss', seenAt: { a: new Stamp() } });
    expect(writes).toHaveLength(2);
    expect(stored(storage, APP)).toBeUndefined();
  });
});

describe('mergeFields', () => {
  it('merges maps field by field and replaces lists and the rest', () => {
    expect(
      mergeFields(
        { a: { x: 1, y: 2 }, list: [1, 2], s: 'one', t: { 'goblin.serverTime': true } },
        { a: { y: 3 }, list: [3], s: { now: 'map' }, t: { 'goblin.serverTime': true } },
      ),
    ).toEqual({
      a: { x: 1, y: 3 },
      list: [3],
      s: { now: 'map' },
      t: { 'goblin.serverTime': true },
    });
  });
});
