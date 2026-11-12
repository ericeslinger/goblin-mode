import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { bytesToBase64, exportDataKey } from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { ONLINE } from '../platform/platform';
import {
  NOTE_KEY_API,
  NOTE_KEY_PATH,
  NOTE_KEY_PREFIX,
  type NoteKeyApi,
  NoteKeyService,
} from './note-key.service';

const raw = (n: number) => bytesToBase64(new Uint8Array(32).fill(n));
const answer = (n: number) =>
  new Response(JSON.stringify({ v: 1, key: raw(n) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function gardener(uid: string): User {
  return { uid, getIdToken: vi.fn(async () => `token-${uid}`) } as unknown as User;
}

function setup(
  respond: NoteKeyApi['fetch'] = async () => answer(1),
  { online = true, stored = {} as Record<string, unknown> } = {},
) {
  localStorage.clear();
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, JSON.stringify(v));
  const user = signal<User | null | undefined>(undefined);
  const isOnline = { value: online };
  const api = { fetch: vi.fn(respond) };
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { user } },
      { provide: NOTE_KEY_API, useValue: api },
      { provide: ONLINE, useValue: () => isOnline.value },
    ],
  });
  const keys = TestBed.inject(NoteKeyService);
  const signIn = (u: User | null) => {
    user.set(u);
    TestBed.tick();
  };
  const bytes = () => {
    const key = keys.key();
    return key ? bytesToBase64(exportDataKey(key)) : undefined;
  };
  return { keys, api, user, signIn, isOnline, bytes };
}

describe('NoteKeyService (note encryption step 2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks nothing until a gardener is signed in', () => {
    const { api, keys, signIn } = setup();
    TestBed.tick();
    expect(api.fetch).not.toHaveBeenCalled();
    signIn(null);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(keys.key()).toBeUndefined();
  });

  it('fetches once when signed in, with the ID token, and keeps a device copy', async () => {
    const { api, signIn, bytes } = setup();
    signIn(gardener('u1'));
    await vi.waitFor(() => expect(bytes()).toBe(raw(1)));
    expect(api.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = api.fetch.mock.calls[0];
    expect(url).toBe(NOTE_KEY_PATH);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer token-u1');
    expect(JSON.parse(localStorage.getItem(`${NOTE_KEY_PREFIX}u1`)!)).toEqual({
      v: 1,
      key: raw(1),
    });
    // Back online, or the same user again: no second ask this load.
    globalThis.dispatchEvent(new Event('online'));
    signIn(gardener('u1'));
    await Promise.resolve();
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the device copy at once offline, and asks nothing', () => {
    const { api, signIn, bytes } = setup(undefined, {
      online: false,
      stored: { [`${NOTE_KEY_PREFIX}u1`]: { v: 1, key: raw(7) } },
    });
    signIn(gardener('u1'));
    expect(bytes()).toBe(raw(7));
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('has no key offline without a device copy, and fetches when back online', async () => {
    const { api, signIn, bytes, isOnline } = setup(undefined, { online: false });
    signIn(gardener('u1'));
    expect(bytes()).toBeUndefined();
    isOnline.value = true;
    globalThis.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(bytes()).toBe(raw(1)));
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it('never throws: a failure is quiet, keeps the device copy, and is tried again online', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const { api, signIn, bytes } = setup(
      async () => {
        calls++;
        if (calls === 1) return new Response('note keys are not configured', { status: 503 });
        if (calls === 2) throw new TypeError('Failed to fetch');
        return answer(2);
      },
      { stored: { [`${NOTE_KEY_PREFIX}u1`]: { v: 1, key: raw(7) } } },
    );
    signIn(gardener('u1'));
    expect(bytes()).toBe(raw(7));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(bytes()).toBe(raw(7));
    globalThis.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    globalThis.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(bytes()).toBe(raw(2)));
    expect(api.fetch).toHaveBeenCalledTimes(3);
  });

  it('ignores an answer that is not a key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { signIn, bytes } = setup(async () => new Response('<!doctype html>', { status: 200 }));
    signIn(gardener('u1'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(bytes()).toBeUndefined();
    expect(localStorage.getItem(`${NOTE_KEY_PREFIX}u1`)).toBeNull();
  });

  it('forgets every device copy and the key on sign-out', async () => {
    const { signIn, keys, bytes } = setup(undefined, {
      stored: { [`${NOTE_KEY_PREFIX}old`]: { v: 1, key: raw(9) }, 'goblin.other': 1 },
    });
    signIn(gardener('u1'));
    await vi.waitFor(() => expect(bytes()).toBe(raw(1)));
    signIn(null);
    expect(keys.key()).toBeUndefined();
    expect(localStorage.getItem(`${NOTE_KEY_PREFIX}u1`)).toBeNull();
    expect(localStorage.getItem(`${NOTE_KEY_PREFIX}old`)).toBeNull();
    expect(localStorage.getItem('goblin.other')).toBe('1');
  });

  it('keeps nothing that arrives after sign-out', async () => {
    let release!: () => void;
    const { signIn, keys } = setup(
      () => new Promise<Response>((resolve) => (release = () => resolve(answer(1)))),
    );
    signIn(gardener('u1'));
    await vi.waitFor(() => expect(release).toBeDefined());
    signIn(null);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(keys.key()).toBeUndefined();
    expect(localStorage.getItem(`${NOTE_KEY_PREFIX}u1`)).toBeNull();
  });

  it("switches to another gardener's own key", async () => {
    const { signIn, bytes } = setup(async (_url, init) =>
      answer(new Headers(init.headers).get('authorization') === 'Bearer token-u2' ? 2 : 1),
    );
    signIn(gardener('u1'));
    await vi.waitFor(() => expect(bytes()).toBe(raw(1)));
    signIn(gardener('u2'));
    expect(bytes()).toBeUndefined();
    await vi.waitFor(() => expect(bytes()).toBe(raw(2)));
  });
});
