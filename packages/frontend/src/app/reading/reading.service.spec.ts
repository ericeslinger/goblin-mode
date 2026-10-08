import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NOW, RANDOM_BYTES } from '../platform/platform';
import { FakeReadingApi, fakeFirebase } from '../testing/fakes';
import { READING_API, ReadingService, WAITED_MS, linkOf } from './reading.service';

const NOW_MS = Date.parse('2026-10-08T12:00:00Z');
const stamp = (ms: number) => ({ toMillis: () => ms });

function setup() {
  const api = new FakeReadingApi();
  const user = signal<User | null | undefined>({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: READING_API, useValue: api },
      { provide: AuthService, useValue: { user } },
      { provide: NOW, useValue: () => NOW_MS },
      { provide: RANDOM_BYTES, useValue: (b: Uint8Array) => b.fill(7) },
    ],
  });
  const reading = TestBed.inject(ReadingService);
  TestBed.tick();
  return { reading, api, user };
}

describe('ReadingService', () => {
  it('lists what is saved to read, newest first, and what has waited a week', () => {
    const { reading, api } = setup();
    expect(api.listen.mock.calls[0][1]).toBe('users/u1/attachments');
    api.push([
      {
        id: 'old',
        data: {
          kind: 'pdf',
          name: 'Old paper',
          read: false,
          pages: 9,
          createdAt: stamp(NOW_MS - WAITED_MS - 1),
        },
      },
      {
        id: 'new',
        data: {
          kind: 'link',
          name: 'Fresh',
          url: 'https://x.test',
          read: false,
          createdAt: stamp(NOW_MS - 1000),
        },
      },
      {
        id: 'done',
        data: { kind: 'link', name: 'Done', read: true, createdAt: stamp(NOW_MS - 2 * WAITED_MS) },
      },
      { id: 'pending', data: { kind: 'link', name: 'Just saved', read: false } },
    ]);
    expect(reading.queue().map((i) => i.id)).toEqual(['pending', 'new', 'old', 'done']);
    expect(reading.unread().map((i) => i.id)).toEqual(['pending', 'new', 'old']);
    expect(reading.waited().map((i) => i.id)).toEqual(['old']);
    expect(reading.queue()[2]).toMatchObject({ kind: 'pdf', pages: 9 });
  });

  it('saves a link at once, as the gardener’s, and marks things read', () => {
    const { reading, api } = setup();
    const id = reading.save('  https://example.com/seeds  ');
    expect(id).toBeDefined();
    const [, path, data, merge] = api.set.mock.lastCall!;
    expect(path).toBe(`users/u1/attachments/${id}`);
    expect(merge).toBe(false);
    expect(data).toMatchObject({
      kind: 'link',
      name: 'https://example.com/seeds',
      url: 'https://example.com/seeds',
      toRead: true,
      read: false,
      createdBy: 'user',
    });
    expect(reading.save('not a link')).toBeUndefined();
    expect(reading.save('javascript:alert(1)')).toBeUndefined();
    reading.setRead('x', true);
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/attachments/x',
      { read: true, updatedAt: 'SERVER_TIME' },
      true,
    ]);
  });

  it('holds a link saved while the account restores, and writes it once known', () => {
    const { reading, api, user } = setup();
    user.set(undefined);
    TestBed.tick();
    const id = reading.save('https://example.com/later');
    expect(api.set).not.toHaveBeenCalled();
    user.set({ uid: 'u1' } as User);
    TestBed.tick();
    expect(api.set.mock.lastCall![1]).toBe(`users/u1/attachments/${id}`);
  });

  it('knows a link', () => {
    expect(linkOf('http://a.test/b')?.hostname).toBe('a.test');
    expect(linkOf('ftp://a.test')).toBeUndefined();
    expect(linkOf('')).toBeUndefined();
  });
});
