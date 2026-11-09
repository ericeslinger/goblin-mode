import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { START_ON_KEY, StartOnService } from '../home/start-on';
import { FakeAuthService, fakeFirebase } from '../testing/fakes';
import { SETTINGS_API, type SettingsApi, ThemeSync } from './theme-sync.service';
import { PREFERS_DARK, THEME_KEY, ThemeService } from './theme.service';

type Next = (data: Record<string, unknown> | undefined, fromCache: boolean, local: boolean) => void;

/** A stand-in settings doc: `push` delivers a snapshot. */
class FakeSettingsApi implements SettingsApi {
  private next: Next = () => undefined;
  readonly stop = vi.fn();
  listen = vi.fn((_db: unknown, _path: string, next: Next) => {
    this.next = next;
    return this.stop;
  });
  set = vi.fn((_db: unknown, _path: string, _data: Record<string, unknown>) => Promise.resolve());
  now = () => 'SERVER_TIME';

  push(data: Record<string, unknown> | undefined, fromCache = false, local = false): void {
    this.next(data, fromCache, local);
  }
}

function setup(stored?: unknown) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(THEME_KEY, JSON.stringify(stored));
  const api = new FakeSettingsApi();
  const auth = new FakeAuthService();
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: auth },
      { provide: SETTINGS_API, useValue: api },
      { provide: PREFERS_DARK, useValue: null },
    ],
  });
  TestBed.inject(ThemeSync);
  const theme = TestBed.inject(ThemeService);
  const startOn = TestBed.inject(StartOnService);
  TestBed.tick();
  const signIn = (uid = 'u1') => {
    auth.user.set({ uid, email: 'eric@example.com' } as User);
    TestBed.tick();
  };
  return { api, auth, theme, startOn, signIn };
}

describe('ThemeSync', () => {
  afterEach(() => localStorage.clear());

  it('listens to the signed-in gardener’s settings doc', () => {
    const { api, signIn } = setup();
    expect(api.listen).not.toHaveBeenCalled();
    signIn('u1');
    expect(api.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/settings/app',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('adopts a choice made on another device, without writing it back', () => {
    const { api, theme, signIn } = setup();
    signIn();
    api.push({ theme: 'pixel', mode: 'dark', updatedAt: 'x' });
    TestBed.tick();
    expect(theme.theme()).toBe('pixel');
    expect(theme.mode()).toBe('dark');
    expect(JSON.parse(localStorage.getItem(THEME_KEY)!)).toEqual({ theme: 'pixel', mode: 'dark' });
    expect(api.set).not.toHaveBeenCalled();
  });

  it('writes a choice made here to the settings doc', () => {
    const { api, theme, signIn } = setup();
    signIn();
    api.push({ theme: 'herbarium', mode: 'system', updatedAt: 'x' });
    theme.set('moss', 'light');
    TestBed.tick();
    expect(api.set).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'users/u1/settings/app', {
      theme: 'moss',
      mode: 'light',
      updatedAt: 'SERVER_TIME',
    });
  });

  it('uploads this device’s choice when the gardener has no settings yet', () => {
    const { api, signIn } = setup({ theme: 'night', mode: 'dark' });
    signIn();
    api.push(undefined);
    expect(api.set).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'users/u1/settings/app', {
      theme: 'night',
      mode: 'dark',
      updatedAt: 'SERVER_TIME',
    });
  });

  it('waits for the server before taking a missing doc as missing', () => {
    const { api, signIn } = setup({ theme: 'night', mode: 'dark' });
    signIn();
    api.push(undefined, true);
    expect(api.set).not.toHaveBeenCalled();
    api.push({ theme: 'pixel', mode: 'light', updatedAt: 'x' });
    expect(api.set).not.toHaveBeenCalled();
  });

  it('drops a choice held from sign-in restore when restore ends signed out', () => {
    const { api, theme, auth, signIn } = setup();
    auth.user.set(undefined);
    TestBed.tick();
    theme.set('moss', 'light');
    TestBed.tick();
    auth.user.set(null);
    TestBed.tick();
    signIn('u2');
    api.push({ theme: 'pixel', mode: 'dark', updatedAt: 'x' });
    expect(api.set).not.toHaveBeenCalled();
    expect(theme.theme()).toBe('pixel');
  });

  it('writes nothing when neither the doc nor this device has a choice', () => {
    const { api, signIn } = setup();
    signIn();
    api.push(undefined);
    expect(api.set).not.toHaveBeenCalled();
  });

  it('writes a choice made while sign-in is restoring, over the older doc', () => {
    const { api, theme, auth, signIn } = setup();
    auth.user.set(undefined);
    TestBed.tick();
    theme.set('moss', 'light');
    TestBed.tick();
    signIn();
    api.push({ theme: 'pixel', mode: 'dark', updatedAt: 'x' });
    expect(theme.theme()).toBe('moss');
    expect(api.set).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'users/u1/settings/app', {
      theme: 'moss',
      mode: 'light',
      updatedAt: 'SERVER_TIME',
    });
  });

  it('never adopts the echo of its own write over a newer choice', () => {
    const { api, theme, signIn } = setup();
    signIn();
    api.push({ theme: 'herbarium', mode: 'system', updatedAt: 'x' });
    theme.set('night', 'system');
    TestBed.tick();
    theme.set('night', 'dark');
    TestBed.tick();
    api.push({ theme: 'night', mode: 'system', updatedAt: 'x' }, false, true);
    expect(theme.mode()).toBe('dark');
  });

  it('ignores a malformed doc', () => {
    const { api, theme, signIn } = setup();
    signIn();
    api.push({ theme: 'neon', mode: 'dark' });
    expect(theme.theme()).toBe('herbarium');
  });

  it('keeps a signed-out choice on this device, and stops listening on sign-out', () => {
    const { api, theme, auth, signIn } = setup();
    theme.set('bog', 'dark');
    TestBed.tick();
    expect(api.set).not.toHaveBeenCalled();
    signIn();
    auth.user.set(null);
    TestBed.tick();
    expect(api.stop).toHaveBeenCalled();
  });

  it('carries Start on in the same doc, both ways (#219)', () => {
    const { api, theme, startOn, signIn } = setup();
    signIn();
    api.push({ theme: 'moss', mode: 'light', startOn: 'home', updatedAt: 'x' });
    TestBed.tick();
    expect(startOn.choice()).toBe('home');
    expect(api.set).not.toHaveBeenCalled();

    startOn.set('right-now');
    TestBed.tick();
    expect(api.set).toHaveBeenLastCalledWith(expect.anything(), 'users/u1/settings/app', {
      theme: 'moss',
      mode: 'light',
      startOn: 'right-now',
      updatedAt: 'SERVER_TIME',
    });
    // A theme chosen later keeps it in the doc, which is written whole.
    theme.set('night', 'dark');
    TestBed.tick();
    expect(api.set).toHaveBeenLastCalledWith(expect.anything(), 'users/u1/settings/app', {
      theme: 'night',
      mode: 'dark',
      startOn: 'right-now',
      updatedAt: 'SERVER_TIME',
    });
  });

  it('keeps this device’s Start on when the doc has none', () => {
    const { api, startOn, signIn } = setup();
    startOn.set('home');
    signIn();
    api.push({ theme: 'moss', mode: 'light', updatedAt: 'x' });
    TestBed.tick();
    expect(startOn.choice()).toBe('home');
  });

  it('writes a Start on chosen while sign-in is restoring, over the older doc', () => {
    const { api, auth, startOn, signIn } = setup();
    auth.user.set(undefined);
    TestBed.tick();
    startOn.set('note');
    TestBed.tick();
    expect(api.set).not.toHaveBeenCalled();
    signIn();
    api.push({ theme: 'herbarium', mode: 'system', startOn: 'home', updatedAt: 'x' }, true);
    TestBed.tick();
    expect(startOn.choice()).toBe('note');
    expect(JSON.parse(localStorage.getItem(START_ON_KEY)!)).toMatchObject({ choice: 'note' });
    expect(api.set).toHaveBeenLastCalledWith(expect.anything(), 'users/u1/settings/app', {
      theme: 'herbarium',
      mode: 'system',
      startOn: 'note',
      updatedAt: 'SERVER_TIME',
    });
  });
});
