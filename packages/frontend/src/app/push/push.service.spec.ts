import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NotesService } from '../notes/notes.service';
import { fakeFirebase } from '../testing/fakes';
import { PUSH_API, PUSH_KEY, type PushApi, PushService } from './push.service';

class FakePushApi implements PushApi {
  configured = true;
  isSupported = true;
  current: NotificationPermission = 'default';
  answer: NotificationPermission = 'granted';
  supported = async () => this.isSupported;
  permission = () => this.current;
  requestPermission = vi.fn(async () => (this.current = this.answer));
  token = vi.fn(async () => 'tok-1');
  deleteToken = vi.fn(async () => undefined);
  save = vi.fn(async (_db: unknown, _path: string, _data: Record<string, unknown>) => undefined);
  remove = vi.fn(async (_db: unknown, _path: string) => undefined);
  serverTime = () => 'SERVER_TIME';
}

async function setup(api = new FakePushApi(), stored: Record<string, unknown> = {}) {
  localStorage.clear();
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, JSON.stringify(v));
  const user = signal<User | null | undefined>(undefined);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(false) },
      { provide: PUSH_API, useValue: api },
      { provide: AuthService, useValue: { user } },
      { provide: NotesService, useValue: { deviceId: () => 'dev1' } },
    ],
  });
  const push = TestBed.inject(PushService);
  const signIn = async () => {
    user.set({ uid: 'u1' } as User);
    TestBed.tick();
    await vi.waitFor(() => expect(push.state()).not.toBe('checking'));
  };
  return { push, api, user, signIn };
}

describe('PushService', () => {
  it('waits for sign-in, then reports off when never turned on', async () => {
    const { push, signIn, api } = await setup();
    expect(push.state()).toBe('checking');
    await signIn();
    expect(push.state()).toBe('off');
    expect(api.token).not.toHaveBeenCalled();
  });

  it('turns on: asks, gets a token and records this device', async () => {
    const { push, signIn, api } = await setup();
    await signIn();
    await push.enable();
    expect(api.requestPermission).toHaveBeenCalled();
    expect(api.save).toHaveBeenCalledWith(expect.anything(), 'users/u1/devices/dev1', {
      token: 'tok-1',
      updatedAt: 'SERVER_TIME',
    });
    expect(push.state()).toBe('on');
    expect(JSON.parse(localStorage.getItem(PUSH_KEY)!)).toBe(true);
  });

  it('says blocked when the browser refuses, and off when the prompt is dismissed', async () => {
    const { push, signIn, api } = await setup();
    await signIn();
    api.answer = 'default';
    await push.enable();
    expect(push.state()).toBe('off');
    api.answer = 'denied';
    await push.enable();
    expect(push.state()).toBe('blocked');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('refreshes the token on sign-in once turned on', async () => {
    const api = new FakePushApi();
    api.current = 'granted';
    const { push, signIn } = await setup(api, { [PUSH_KEY]: true });
    await signIn();
    expect(push.state()).toBe('on');
    expect(api.requestPermission).not.toHaveBeenCalled();
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it('does not register a device that was turned off, even with permission', async () => {
    const api = new FakePushApi();
    api.current = 'granted';
    const { push, signIn } = await setup(api, { [PUSH_KEY]: false });
    await signIn();
    expect(push.state()).toBe('off');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('turns off: removes the device and the token', async () => {
    const { push, signIn, api } = await setup();
    await signIn();
    await push.enable();
    await push.disable();
    expect(api.remove).toHaveBeenCalledWith(expect.anything(), 'users/u1/devices/dev1');
    expect(api.deleteToken).toHaveBeenCalled();
    expect(push.state()).toBe('off');
    expect(JSON.parse(localStorage.getItem(PUSH_KEY)!)).toBe(false);
  });

  it('reports unsupported, unconfigured, blocked and errors', async () => {
    const unsupported = new FakePushApi();
    unsupported.isSupported = false;
    let s = await setup(unsupported);
    await s.signIn();
    expect(s.push.state()).toBe('unsupported');

    TestBed.resetTestingModule();
    const unconfigured = new FakePushApi();
    unconfigured.configured = false;
    s = await setup(unconfigured);
    await s.signIn();
    expect(s.push.state()).toBe('unconfigured');

    TestBed.resetTestingModule();
    const blocked = new FakePushApi();
    blocked.current = 'denied';
    s = await setup(blocked);
    await s.signIn();
    expect(s.push.state()).toBe('blocked');

    TestBed.resetTestingModule();
    const failing = new FakePushApi();
    failing.token.mockRejectedValue(new Error('the app is not installed yet'));
    s = await setup(failing);
    await s.signIn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await s.push.enable();
    expect(s.push.state()).toBe('error');
    expect(s.push.error()).toBe('the app is not installed yet');
  });

  it('turns a device that was on off before sign-out, and leaves others alone', async () => {
    const { push, signIn, api } = await setup();
    await signIn();
    await push.beforeSignOut();
    expect(api.remove).not.toHaveBeenCalled();
    await push.enable();
    await push.beforeSignOut();
    expect(api.remove).toHaveBeenCalledWith(expect.anything(), 'users/u1/devices/dev1');
    expect(api.deleteToken).toHaveBeenCalled();
    expect(push.state()).toBe('off');
  });

  it('goes back to checking on sign-out', async () => {
    const { push, signIn, user } = await setup();
    await signIn();
    user.set(null);
    TestBed.tick();
    expect(push.state()).toBe('checking');
  });
});
