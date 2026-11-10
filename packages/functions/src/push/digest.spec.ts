import { describe, expect, it } from 'vitest';
import { type DigestStore, digestMessage, sendDigests, zoneOf } from './digest';
import type { PushSender } from './send-due';

const NOW = Date.parse('2026-11-09T13:10:00Z');

function store(over: Partial<DigestStore> = {}): DigestStore & { claimed: string[] } {
  const claimed: string[] = [];
  return {
    claimed,
    subscribers: async () => [],
    records: async () => [
      {
        at: Date.parse('2026-11-08T12:00:00Z'),
        tool: 'create_note',
        summary: 'Wrote a new note',
        notes: [{ id: 'g', title: 'Gift ideas', made: true }],
      },
    ],
    projects: async () => new Set(),
    claim: async (uid, day) => {
      const key = `${uid}:${day}`;
      if (claimed.includes(key)) return false;
      claimed.push(key);
      return true;
    },
    devices: async () => [{ id: 'd', token: 't' }],
    removeDevice: async () => undefined,
    ...over,
  };
}

const sender = (): PushSender & { bodies: string[] } => {
  const bodies: string[] = [];
  return {
    bodies,
    send: async (tokens, m) => {
      bodies.push(m.body);
      return tokens.map(() => 'sent');
    },
  };
};

describe('zoneOf', () => {
  it('keeps a real zone and reads a missing or unknown one as UTC', () => {
    expect(zoneOf('Europe/Paris')).toBe('Europe/Paris');
    expect(zoneOf(undefined)).toBe('UTC');
    expect(zoneOf('Mars/Olympus')).toBe('UTC');
  });
});

describe('sendDigests', () => {
  it('reads an unknown zone as UTC, and claims the day before sending', async () => {
    const s = store({
      subscribers: async () => [{ uid: 'a', hour: 13, timeZone: 'Mars/Olympus' }],
    });
    const push = sender();
    expect(await sendDigests(s, push, NOW)).toMatchObject({ due: 1, pushed: 1, sent: 1 });
    expect(s.claimed).toEqual(['a:2026-11-09']);
    expect(push.bodies).toEqual(['Yesterday: Gift ideas made.']);
    expect(await sendDigests(s, push, NOW)).toMatchObject({ already: 1, pushed: 0 });
    expect(push.bodies).toHaveLength(1);
  });

  it('asks which linked notes are projects only when a link was made', async () => {
    const asked: string[][] = [];
    const s = store({
      subscribers: async () => [{ uid: 'a', hour: 13 }],
      records: async () => [
        {
          at: Date.parse('2026-11-08T12:00:00Z'),
          tool: 'link_notes',
          summary: 'Linked a note to 2 others',
          notes: [
            { id: 'k', title: 'Glaze test' },
            { id: 'p', title: 'Pottery' },
            { id: 'c', title: 'Clay' },
          ],
        },
      ],
      projects: async (_uid, ids) => {
        asked.push(ids);
        return new Set(['p']);
      },
    });
    const push = sender();
    await sendDigests(s, push, NOW);
    expect(asked).toEqual([['p', 'c']]);
    expect(push.bodies).toEqual(['Yesterday: 1 note filed under Pottery.']);
  });

  it('opens What assistants changed from the push', () => {
    expect(digestMessage('Yesterday: 2 changes.')).toEqual({
      tag: 'digest',
      title: 'What assistants changed',
      body: 'Yesterday: 2 changes.',
      url: '/activity',
    });
  });
});
