import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type DataKey, keyCheckProof, newDataKey } from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ONLINE, RANDOM_BYTES } from '../platform/platform';
import { SETTINGS_API, type SettingsApi } from '../theme/theme-sync.service';
import { NoteKeyService, NoteKeyUnavailable } from './note-key.service';
import { KEY_CHECK_API, SealingService, type ServerPart } from './sealing.service';

// The gardener's switch (2026-11-15): read from settings/assistant,
// turned on only after the check that this device and the functions get
// the same key, and off with a write alone.

function setup({ keep = false }: { keep?: boolean } = {}) {
  if (!keep) localStorage.clear();
  let next: (data: Record<string, unknown> | undefined, fromCache?: boolean) => void = () =>
    undefined;
  const api = {
    listen: vi.fn((_db, _path: string, n) => {
      next = (d, fromCache = false) => n(d, fromCache, false);
      return () => undefined;
    }),
    set: vi.fn(async () => undefined),
    now: () => 'NOW',
  } satisfies SettingsApi;
  const deviceKey: { key: DataKey | undefined; fails?: Error } = { key: newDataKey() };
  const keys = {
    key: signal<DataKey | undefined>(undefined),
    fetchNow: vi.fn(async () => {
      if (deviceKey.fails) throw deviceKey.fails;
      return deviceKey.key!;
    }),
  };
  /** Each part's key: the device's unless a spec gives another, or makes it fail. */
  const server: Partial<Record<ServerPart, { key?: DataKey; fails?: Error }>> = {};
  const check = {
    check: vi.fn(async (part: ServerPart, nonce: string) => {
      const p = server[part];
      if (p?.fails) throw p.fails;
      return { v: 1, proof: keyCheckProof(p?.key ?? deviceKey.key!, 'u1', nonce) };
    }),
  };
  const online = signal(true);
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_API, useValue: api },
      { provide: FIREBASE, useValue: { db: {} } },
      { provide: AuthService, useValue: { user: signal<User | null>({ uid: 'u1' } as User) } },
      { provide: NoteKeyService, useValue: keys },
      { provide: KEY_CHECK_API, useValue: check },
      { provide: ONLINE, useValue: () => online() },
      { provide: RANDOM_BYTES, useValue: (b: Uint8Array) => b.fill(7) },
    ],
  });
  const sealing = TestBed.inject(SealingService);
  TestBed.tick();
  return {
    sealing,
    api,
    keys,
    check,
    deviceKey,
    server,
    online,
    settings: (d?: object, fromCache = false) => next(d as Record<string, unknown>, fromCache),
  };
}

const writes = (api: ReturnType<typeof setup>['api']) =>
  api.set.mock.calls.map((c) => (c as unknown[])[2]);

describe('SealingService', () => {
  it('is off and unheard until the setting is read, then follows it', () => {
    const { sealing, settings, api } = setup();
    expect(api.listen.mock.calls[0][1]).toBe('users/u1/settings/assistant');
    expect(sealing.on()).toBe(false);
    expect(sealing.known()).toBe(false);
    settings(undefined);
    expect(sealing.known()).toBe(true);
    expect(sealing.on()).toBe(false);
    settings({ sealNotes: true });
    expect(sealing.on()).toBe(true);
    settings({ sealNotes: 'yes' });
    expect(sealing.on()).toBe(false);
  });

  it('is not known from a cache with no doc, but is from the server, and remembers it (review on #276)', () => {
    const first = setup();
    first.settings(undefined, true);
    expect(first.sealing.known()).toBe(false);
    first.settings({ sealNotes: true, updatedAt: 1 }, true);
    expect(first.sealing.known()).toBe(true);
    first.settings({ sealNotes: true });
    expect(localStorage.getItem('goblin.sealNotes.u1')).toBe('on');
    // A later start, offline with nothing cached: known at once from the device.
    TestBed.resetTestingModule();
    const next = setup({ keep: true });
    expect(next.sealing.known()).toBe(true);
    expect(next.sealing.on()).toBe(true);
    next.settings(undefined, true);
    expect(next.sealing.on()).toBe(true);
  });

  it('a garden with no settings doc: known, off, as soon as the server says so (e2e capture offline)', () => {
    const { sealing, settings } = setup();
    // Offline: the cache has no doc, which says nothing.
    settings(undefined, true);
    expect(sealing.known()).toBe(false);
    // Back online: the listener asks for metadata changes, so the
    // server's "no doc" comes as its own snapshot.
    settings(undefined, false);
    expect(sealing.known()).toBe(true);
    expect(sealing.on()).toBe(false);
    expect(localStorage.getItem('goblin.sealNotes.u1')).toBe('off');
  });

  it('turns on when every part of the server proves the same key, with a merge write of the switch alone', async () => {
    const { sealing, api, check, keys } = setup();
    expect(await sealing.turnOn()).toEqual({ result: 'ok' });
    expect(keys.fetchNow).toHaveBeenCalledTimes(1);
    // All three parts asked, each with the one fresh nonce: never the key.
    expect(check.check.mock.calls.map(([part]) => part).sort()).toEqual([
      'main',
      'runner',
      'titles',
    ]);
    const [, nonce] = check.check.mock.calls[0];
    expect(new Set(check.check.mock.calls.map(([, n]) => n)).size).toBe(1);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(sealing.on()).toBe(true);
    expect(writes(api)).toEqual([{ sealNotes: true, updatedAt: 'NOW' }]);
    expect((api.set.mock.calls[0] as unknown[])[3]).toBe(true);
  });

  it('stays off when one part of the server was given another key', async () => {
    const { sealing, api, server } = setup();
    server.runner = { key: newDataKey() };
    expect(await sealing.turnOn()).toEqual({
      result: 'server',
      failed: [],
      mismatched: ['runner'],
    });
    expect(sealing.on()).toBe(false);
    expect(api.set).not.toHaveBeenCalled();
  });

  it('stays off, saying which side failed, when the device or a part of the server cannot get its key', async () => {
    const { sealing, api, deviceKey, server, check } = setup();
    deviceKey.fails = new NoteKeyUnavailable('the note key service answered 503');
    expect(await sealing.turnOn()).toEqual({
      result: 'device',
      why: 'the note key service answered 503',
    });
    expect(check.check).not.toHaveBeenCalled();
    deviceKey.fails = undefined;
    server.titles = { fails: new Error('The server is not set up to ask for note keys.') };
    expect(await sealing.turnOn()).toEqual({
      result: 'server',
      failed: [{ part: 'titles', why: 'The server is not set up to ask for note keys.' }],
      mismatched: [],
    });
    expect(sealing.on()).toBe(false);
    expect(api.set).not.toHaveBeenCalled();
  });

  it('needs a connection for the check', async () => {
    const { sealing, online, keys, api } = setup();
    online.set(false);
    expect(await sealing.turnOn()).toEqual({ result: 'offline' });
    expect(keys.fetchNow).not.toHaveBeenCalled();
    expect(api.set).not.toHaveBeenCalled();
  });

  it('turns off with a write alone, no check and no key', () => {
    const { sealing, api, settings, keys, check } = setup();
    settings({ sealNotes: true });
    sealing.turnOff();
    expect(sealing.on()).toBe(false);
    expect(writes(api)).toEqual([{ sealNotes: false, updatedAt: 'NOW' }]);
    expect(keys.fetchNow).not.toHaveBeenCalled();
    expect(check.check).not.toHaveBeenCalled();
  });
});
