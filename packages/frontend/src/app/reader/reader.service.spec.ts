import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FEED_CAP, feedId } from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { FakeReaderApi, fakeFirebase } from '../testing/fakes';
import { READER_API, ReaderService } from './reader.service';

const OPML = `<opml><body>
  <outline text="Design">
    <outline text="Kottke" xmlUrl="https://kottke.org/main/index.xml" htmlUrl="https://kottke.org/"/>
  </outline>
  <outline text="Games">
    <outline text="Kottke" xmlUrl="https://kottke.org/main/index.xml"/>
    <outline text="Dice" xmlUrl="https://dice.example/feed"/>
  </outline>
</body></opml>`;

function setup() {
  const api = new FakeReaderApi();
  const user = signal<User | null | undefined>({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: READER_API, useValue: api },
      { provide: AuthService, useValue: { user } },
    ],
  });
  const reader = TestBed.inject(ReaderService);
  TestBed.tick();
  return { reader, api, user };
}

describe('ReaderService (#159)', () => {
  it('lists the feeds by folder, Uncategorized last', () => {
    const { reader, api } = setup();
    expect(api.listen.mock.calls[0][1]).toBe('users/u1/feeds');
    expect(reader.loaded()).toBe(false);
    api.push([
      { id: 'a', data: { url: 'https://a.test/f', title: 'Alpha', folders: ['Games'] } },
      { id: 'b', data: { url: 'https://b.test/f', title: 'Beta', folders: [], dead: true } },
    ]);
    expect(reader.loaded()).toBe(true);
    expect(reader.folders().map((f) => [f.name, f.feeds.map((x) => x.id)])).toEqual([
      ['Games', ['a']],
      ['Uncategorized', ['b']],
    ]);
    expect(reader.feeds()[1].dead).toBe(true);
  });

  it('imports an OPML file once: twice is known, folders union', () => {
    const { reader, api } = setup();
    api.push([]);
    expect(reader.importOpml(OPML)).toEqual({ added: 2, known: 0, refused: 0 });
    const kottke = feedId('https://kottke.org/main/index.xml');
    const [, path, data, merge] = api.set.mock.calls[0];
    expect(path).toBe(`users/u1/feeds/${kottke}`);
    expect(merge).toBe(false);
    expect(data).toMatchObject({
      url: 'https://kottke.org/main/index.xml',
      title: 'Kottke',
      site: 'https://kottke.org/',
      folders: ['Design', 'Games'],
      nextFetchAt: 'SERVER_TIME',
    });
    expect(api.set).toHaveBeenCalledTimes(2);
    // Again, with a folder the first file did not have.
    expect(reader.importOpml(OPML.replace('Design', 'Art'))).toEqual({
      added: 0,
      known: 2,
      refused: 0,
    });
    expect(api.set).toHaveBeenCalledTimes(3);
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      `users/u1/feeds/${kottke}`,
      { folders: ['Design', 'Games', 'Art'], updatedAt: 'SERVER_TIME' },
      true,
    ]);
    expect(reader.importOpml('<opml><body/></opml>')).toBeUndefined();
  });

  it('refuses feeds past the cap', () => {
    const { reader, api } = setup();
    api.push(
      Array.from({ length: FEED_CAP - 1 }, (_, i) => ({
        id: `f${i}`,
        data: { url: `https://x.test/${i}`, title: `${i}`, folders: [] },
      })),
    );
    expect(reader.importOpml(OPML)).toEqual({ added: 1, known: 0, refused: 1 });
    expect(reader.addFeed('https://one.more/feed')).toBeUndefined();
  });

  it('adds one feed by its link, moves it, and removes it', () => {
    const { reader, api } = setup();
    api.push([]);
    expect(reader.addFeed('ftp://nope')).toBeUndefined();
    const id = reader.addFeed(' https://dice.example/feed#x ', 'Games');
    expect(id).toBe(feedId('https://dice.example/feed'));
    expect(api.set.mock.lastCall![2]).toMatchObject({
      url: 'https://dice.example/feed',
      title: 'dice.example',
      folders: ['Games'],
    });
    // Known already: into the folder, not a second feed.
    expect(reader.addFeed('https://dice.example/feed', 'Design')).toBe(id);
    expect(api.set).toHaveBeenCalledTimes(2);
    expect(api.set.mock.lastCall![2]).toEqual({
      folders: ['Games', 'Design'],
      updatedAt: 'SERVER_TIME',
    });
    reader.setFolders(id!, [' Art ', 'Art', '']);
    expect(api.set.mock.lastCall![2]).toEqual({ folders: ['Art'], updatedAt: 'SERVER_TIME' });
    expect(reader.folderNames()).toEqual(['Art']);
    reader.removeFeed(id!);
    expect(api.remove).toHaveBeenCalledWith({}, `users/u1/feeds/${id}`);
    expect(reader.feeds()).toEqual([]);
  });

  it('writes nothing while signed out', () => {
    const { reader, api, user } = setup();
    user.set(null);
    TestBed.tick();
    expect(reader.addFeed('https://dice.example/feed')).toBeUndefined();
    expect(reader.importOpml(OPML)).toBeUndefined();
    expect(api.set).not.toHaveBeenCalled();
  });
});
