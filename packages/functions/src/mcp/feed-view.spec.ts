import { describe, expect, it } from 'vitest';
import { feedItemView, queueRanks } from './tools';

describe('feedItemView (#178)', () => {
  const feeds = new Map([['f-1', { title: 'Kiln hour', folders: [] }]]);
  const base = { feedId: 'f-1', title: 'Wedging clay', link: 'https://pod.invalid/1' };

  it('carries an episode’s audio, artwork and number', () => {
    const view = feedItemView(
      'f-1-a',
      {
        ...base,
        enclosure: {
          url: 'https://pod.invalid/1.mp3',
          type: 'audio/mpeg',
          bytes: 62914560,
          seconds: 3900,
        },
        image: 'https://pod.invalid/1.jpg',
        episode: 1,
      },
      feeds,
    );
    expect(view).toMatchObject({
      feed: 'Kiln hour',
      enclosure: {
        url: 'https://pod.invalid/1.mp3',
        type: 'audio/mpeg',
        bytes: 62914560,
        seconds: 3900,
      },
      image: 'https://pod.invalid/1.jpg',
      episode: 1,
    });
    expect(view.fromWeb).toContain('content from the web');
  });

  it('carries where Eric left an episode, and whether he heard it all (#179)', () => {
    const view = feedItemView('f-1-a', { ...base, position: 754.5, played: false }, feeds);
    expect(view).toMatchObject({ position: 754.5 });
    expect(view).not.toHaveProperty('played');
    const done = feedItemView('f-1-a', { ...base, position: 3900, played: true }, feeds);
    expect(done).toMatchObject({ position: 3900, played: true });
    expect(feedItemView('f-1-a', { ...base, position: '12:34' }, feeds)).not.toHaveProperty(
      'position',
    );
  });

  it('leaves them out of an article, and drops what is no web link', () => {
    const article = feedItemView('f-1-b', base, feeds);
    expect(article).not.toHaveProperty('enclosure');
    expect(article).not.toHaveProperty('image');
    expect(article).not.toHaveProperty('episode');
    const odd = feedItemView(
      'f-1-c',
      { ...base, enclosure: { url: 'javascript:alert(1)', type: 'audio/mpeg' }, image: 'data:x' },
      feeds,
    );
    expect(odd).not.toHaveProperty('enclosure');
    expect(odd).not.toHaveProperty('image');
  });

  it('says when its feed is in Podcasts (#245), and nothing for the Reader’s', () => {
    const both = new Map([
      ['f-1', { title: 'Kiln hour', folders: [], podcast: true }],
      ['f-2', { title: 'Design notes', folders: [] }],
    ]);
    expect(feedItemView('f-1-a', base, both)).toMatchObject({ podcast: true });
    expect(feedItemView('f-2-a', { ...base, feedId: 'f-2' }, both)).not.toHaveProperty('podcast');
  });

  it('carries the tags an import gave it (#176), and none when it has none', () => {
    expect(feedItemView('f-1-t', { ...base, tags: ['Pottery', 7] }, feeds)).toMatchObject({
      tags: ['Pottery'],
    });
    expect(feedItemView('f-1-t', base, feeds)).not.toHaveProperty('tags');
  });

  it('says an episode is in the listening queue and where, 1 next (#249)', () => {
    const shows = new Map([
      ['f-1', { title: 'Kiln hour', folders: [], podcast: true }],
      ['f-2', { title: 'Design notes', folders: [] }],
    ]);
    const audio = { enclosure: { url: 'https://pod.invalid/1.mp3', type: 'audio/mpeg' } };
    const ranks = queueRanks(
      [
        { id: 'b', data: { feedId: 'f-1', queue: 5, ...audio } },
        { id: 'a', data: { feedId: 'f-1', queue: 5, ...audio } },
        { id: 'c', data: { feedId: 'f-1', queue: -1, ...audio } },
        // Not what the app shows as the queue: no audio, a Reader feed's, a string.
        { id: 'd', data: { feedId: 'f-1', queue: 1 } },
        { id: 'e', data: { feedId: 'f-2', queue: 1, ...audio } },
        { id: 'f', data: { feedId: 'f-1', queue: '1', ...audio } },
      ],
      shows,
    );
    expect([...ranks]).toEqual([
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ]);
    expect(feedItemView('a', { ...base, ...audio }, shows, ranks)).toMatchObject({
      queued: true,
      queuePosition: 2,
    });
    const out = feedItemView('d', base, shows, ranks);
    expect(out).not.toHaveProperty('queued');
    expect(out).not.toHaveProperty('queuePosition');
    expect(feedItemView('a', base, shows)).not.toHaveProperty('queued');
  });
});
