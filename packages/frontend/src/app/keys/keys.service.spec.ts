import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { TIME_ZONE } from '../platform/platform';
import { SETTINGS_API, type SettingsApi } from '../theme/theme-sync.service';
import { KEYS_API, KeysService } from './keys.service';

function setup() {
  const next = new Map<string, (data: Record<string, unknown> | undefined) => void>();
  const local = new Map<string, (data: Record<string, unknown> | undefined) => void>();
  const settles: (() => void)[] = [];
  const api = {
    listen: vi.fn((_db, path: string, n) => {
      next.set(path, (d) => n(d, false, false));
      local.set(path, (d) => n(d, false, true));
      return () => undefined;
    }),
    set: vi.fn((): Promise<void> => new Promise<void>((done) => settles.push(done))),
    now: () => 'NOW',
  } satisfies SettingsApi;
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_API, useValue: api },
      { provide: FIREBASE, useValue: { db: {} } },
      { provide: AuthService, useValue: { user: signal<User | null>({ uid: 'u1' } as User) } },
      { provide: KEYS_API, useValue: { save: vi.fn(), remove: vi.fn() } },
      { provide: TIME_ZONE, useValue: 'America/New_York' },
    ],
  });
  const keys = TestBed.inject(KeysService);
  TestBed.tick();
  const assistant = (d: Record<string, unknown> | undefined) =>
    next.get('users/u1/settings/assistant')!(d);
  const echo = (d: Record<string, unknown> | undefined) =>
    local.get('users/u1/settings/assistant')!(d);
  // Every write so far acknowledged; a microtask later, as a promise's.
  const acknowledge = async () => {
    settles.splice(0).forEach((done) => done());
    await Promise.resolve();
    await Promise.resolve();
  };
  return { keys, api, assistant, echo, acknowledge };
}

describe('KeysService, the daily digest (#237)', () => {
  it('reads the digest switch and hour, off at 8 until set, and a garbled one as off', () => {
    const { keys, assistant } = setup();
    expect(keys.digest()).toEqual({ push: false, hour: 8 });
    assistant({ digest: { push: true, hour: 21, timeZone: 'Europe/Paris' } });
    expect(keys.digest()).toEqual({ push: true, hour: 21 });
    assistant({ digest: { push: 'yes', hour: 30 } });
    expect(keys.digest()).toEqual({ push: false, hour: 8 });
    assistant({ digest: 'on' });
    expect(keys.digest()).toEqual({ push: false, hour: 8 });
  });

  it('writes the switch alone with a merge write, the device’s time zone beside it', () => {
    const { keys, api, assistant } = setup();
    assistant({ digest: { push: false, hour: 7 } });
    keys.setDigestPush(true);
    expect(keys.digest()).toEqual({ push: true, hour: 7 });
    expect(api.set).toHaveBeenCalledWith(
      {},
      'users/u1/settings/assistant',
      { digest: { push: true, timeZone: 'America/New_York' }, updatedAt: 'NOW' },
      true,
    );
  });

  it('writes the hour alone, and refuses one off the clock', () => {
    const { keys, api, assistant } = setup();
    assistant({ digest: { push: true, hour: 8 } });
    keys.setDigestHour(21);
    expect(keys.digest()).toEqual({ push: true, hour: 21 });
    expect(api.set).toHaveBeenLastCalledWith(
      {},
      'users/u1/settings/assistant',
      { digest: { hour: 21, timeZone: 'America/New_York' }, updatedAt: 'NOW' },
      true,
    );
    api.set.mockClear();
    keys.setDigestHour(24);
    expect(api.set).not.toHaveBeenCalled();
    expect(keys.digest().hour).toBe(21);
  });

  it('fills a field the doc never had once, so the stored digest has both', () => {
    const { keys, api, assistant } = setup();
    assistant(undefined);
    keys.setDigestPush(true);
    expect(api.set).toHaveBeenLastCalledWith(
      {},
      'users/u1/settings/assistant',
      { digest: { push: true, hour: 8, timeZone: 'America/New_York' }, updatedAt: 'NOW' },
      true,
    );
    keys.setDigestHour(21);
    expect(api.set).toHaveBeenLastCalledWith(
      {},
      'users/u1/settings/assistant',
      { digest: { hour: 21, timeZone: 'America/New_York' }, updatedAt: 'NOW' },
      true,
    );
  });

  it('keeps the switch just set over a snapshot from before it, and the hour beside it does not undo it (#224)', async () => {
    const { keys, api, assistant, echo, acknowledge } = setup();
    // The cache's answer from before the doc existed, then the switch,
    // then the server's answer made before the switch's write.
    assistant(undefined);
    keys.setDigestPush(true);
    assistant(undefined);
    expect(keys.digest()).toEqual({ push: true, hour: 8 });
    keys.setDigestHour(21);
    expect(keys.digest()).toEqual({ push: true, hour: 21 });
    const written = api.set.mock.calls.map((c) => (c as unknown[])[2]);
    expect(written).toEqual([
      { digest: { push: true, hour: 8, timeZone: 'America/New_York' }, updatedAt: 'NOW' },
      { digest: { hour: 21, timeZone: 'America/New_York' }, updatedAt: 'NOW' },
    ]);
    // The echo of the first write, made before the second, is passed over too.
    echo({ digest: { push: true, hour: 8 } });
    expect(keys.digest()).toEqual({ push: true, hour: 21 });
    await acknowledge();
    // Acknowledged, the doc is adopted again: another device's change shows.
    assistant({ digest: { push: false, hour: 21 } });
    expect(keys.digest()).toEqual({ push: false, hour: 21 });
  });

  it('keeps the switch set before the doc is first heard, over that first snapshot (#224)', async () => {
    const { keys, assistant, echo, acknowledge } = setup();
    keys.setDigestPush(true);
    assistant(undefined);
    echo({ digest: { push: true, hour: 8 } });
    expect(keys.digest()).toEqual({ push: true, hour: 8 });
    await acknowledge();
    assistant({ digest: { push: true, hour: 8 }, gardenOnArrival: true });
    expect(keys.onArrival()).toBe(true);
  });
});

describe('KeysService, Garden new notes on arrival (#214, #229)', () => {
  it('keeps a template just skipped over a snapshot from before it, so the next skip keeps both (#224)', () => {
    const { keys, api, assistant } = setup();
    assistant({ arrivalSkip: { templates: [], tags: [] } });
    keys.setArrivalSkip({ templates: ['t1'], tags: [] });
    assistant({ arrivalSkip: { templates: [], tags: [] } });
    expect(keys.arrivalSkip().templates).toEqual(['t1']);
    keys.setArrivalSkip({
      ...keys.arrivalSkip(),
      templates: [...keys.arrivalSkip().templates, 't2'],
    });
    expect(api.set).toHaveBeenLastCalledWith(
      {},
      'users/u1/settings/assistant',
      { arrivalSkip: { templates: ['t1', 't2'], tags: [] }, updatedAt: 'NOW' },
      true,
    );
  });
});
