import { exportDataKey } from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  NoteKeyServiceError,
  NoteKeysUnconfigured,
  noteKeys,
  noteKeysFromEnv,
  workerSource,
} from './client';

const SECRET = 'the-service-secret-for-these-specs-0001';
const raw = (n: number) => new Uint8Array(32).fill(n);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function worker(answer: (uid: string) => Response | Promise<Response>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { uid } = JSON.parse(String(init?.body)) as { uid: string };
    return answer(uid);
  });
}

const keyFor = (uid: string) =>
  Response.json({ v: 1, key: b64(raw(uid === 'u1' ? 1 : 2)) }, { status: 200 });

describe('workerSource (note encryption step 2)', () => {
  it('asks the Worker with the service secret, the uid in the body, following no redirect', async () => {
    const fetch = worker(keyFor);
    const bytes = await workerSource({ origin: 'https://notes.example', secret: SECRET, fetch })(
      'u1',
    );
    expect(bytes).toEqual(raw(1));
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://notes.example/api/note-key/for');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(init?.body))).toEqual({ uid: 'u1' });
    expect(init?.redirect).toBe('error');
  });

  it('says unconfigured on a 503, and a service error on any other refusal or bad answer', async () => {
    const ask = (res: Response) =>
      workerSource({ origin: 'https://n.example', secret: SECRET, fetch: worker(() => res) })('u1');
    await expect(ask(new Response('no', { status: 503 }))).rejects.toBeInstanceOf(
      NoteKeysUnconfigured,
    );
    await expect(ask(new Response('no', { status: 401 }))).rejects.toMatchObject({
      name: 'NoteKeyServiceError',
      status: 401,
    });
    await expect(ask(Response.json({ v: 1, key: 'short' }))).rejects.toBeInstanceOf(
      NoteKeyServiceError,
    );
    await expect(ask(new Response('not json'))).rejects.toBeInstanceOf(NoteKeyServiceError);
    const down = workerSource({
      origin: 'https://n.example',
      secret: SECRET,
      fetch: vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    });
    await expect(down('u1')).rejects.toBeInstanceOf(NoteKeyServiceError);
  });

  it('never puts the secret in an error', async () => {
    const source = workerSource({
      origin: 'https://n.example',
      secret: SECRET,
      fetch: worker(() => new Response(SECRET, { status: 500 })),
    });
    const err = await source('u1').catch((e: Error) => e);
    expect(String(err)).not.toContain(SECRET);
  });
});

describe('noteKeys', () => {
  it('asks once per uid and keeps the key for the instance', async () => {
    const source = vi.fn(async (uid: string) => raw(uid === 'u1' ? 1 : 2));
    const keys = noteKeys(source);
    const [a, b] = await Promise.all([keys.dataKeyFor('u1'), keys.dataKeyFor('u1')]);
    expect(a).toBe(b);
    expect(await keys.dataKeyFor('u1')).toBe(a);
    expect(exportDataKey(a)).toEqual(raw(1));
    expect(exportDataKey(await keys.dataKeyFor('u2'))).toEqual(raw(2));
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('keeps no failure, so the next ask tries again', async () => {
    const source = vi
      .fn<(uid: string) => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new NoteKeyServiceError('down'))
      .mockResolvedValue(raw(3));
    const keys = noteKeys(source);
    await expect(keys.dataKeyFor('u1')).rejects.toBeInstanceOf(NoteKeyServiceError);
    expect(exportDataKey(await keys.dataKeyFor('u1'))).toEqual(raw(3));
    expect(source).toHaveBeenCalledTimes(2);
  });
});

describe('noteKeysFromEnv', () => {
  it('throws the typed error when the secret or the domain is missing', async () => {
    for (const env of [
      {},
      { APP_DOMAIN: 'notes.example' },
      { NOTE_KEYS_SERVICE: SECRET },
      { APP_DOMAIN: 'https://notes.example/', NOTE_KEYS_SERVICE: SECRET },
    ]) {
      await expect(noteKeysFromEnv(env).dataKeyFor('u1')).rejects.toBeInstanceOf(
        NoteKeysUnconfigured,
      );
    }
  });

  it('asks the app domain over https when both are set', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => keyFor('u1'));
    try {
      const keys = noteKeysFromEnv({ APP_DOMAIN: 'notes.example', NOTE_KEYS_SERVICE: SECRET });
      expect(exportDataKey(await keys.dataKeyFor('u1'))).toEqual(raw(1));
      expect(String(fetch.mock.calls[0][0])).toBe('https://notes.example/api/note-key/for');
    } finally {
      fetch.mockRestore();
    }
  });

  it('has no stand-in outside the emulator build, even under the emulator', async () => {
    const env = { FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
    await expect(noteKeysFromEnv(env).dataKeyFor('u1')).rejects.toBeInstanceOf(
      NoteKeysUnconfigured,
    );
  });
});
