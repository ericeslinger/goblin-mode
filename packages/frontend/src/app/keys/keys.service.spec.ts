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
  const api = {
    listen: vi.fn((_db, path: string, n) => {
      next.set(path, (d) => n(d, false, false));
      return () => undefined;
    }),
    set: vi.fn(async () => undefined),
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
  return { keys, api, assistant };
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

  it('writes it with a merge write, the device’s time zone beside it', () => {
    const { keys, api } = setup();
    keys.setDigest({ push: true, hour: 7 });
    expect(keys.digest()).toEqual({ push: true, hour: 7 });
    expect(api.set).toHaveBeenCalledWith(
      {},
      'users/u1/settings/assistant',
      { digest: { push: true, hour: 7, timeZone: 'America/New_York' }, updatedAt: 'NOW' },
      true,
    );
    api.set.mockClear();
    keys.setDigest({ push: true, hour: 24 });
    expect(api.set).not.toHaveBeenCalled();
  });
});
