import { describe, expect, it } from 'vitest';
import { canPutBack, putBackDepth, putBackId, rerouteId, rerouteNotes } from './putback';

describe('put back ids', () => {
  it('derives a put back’s id from its run, and reads the depth back', () => {
    expect(putBackId('abc')).toBe('putback-abc');
    expect(putBackDepth('abc')).toEqual({ base: 'abc', depth: 0 });
    expect(putBackDepth(putBackId(putBackId('abc')))).toEqual({ base: 'abc', depth: 2 });
  });

  it('offers Put back for runs that touched notes History can undo', () => {
    expect(canPutBack({ tool: 'add_lines', notes: [{}] })).toBe(true);
    expect(canPutBack({ tool: 'put_back', notes: [{}] })).toBe(true);
    expect(canPutBack({ tool: 'create_reminder', notes: [] })).toBe(false);
    // Filing and a finished queue item, once their records keep what they replaced (#206).
    expect(canPutBack({ tool: 'refile', notes: [{}] })).toBe(false);
    expect(canPutBack({ tool: 'finish_queued', notes: [{}] })).toBe(false);
    expect(canPutBack({ tool: 'refile', notes: [{ before: { tags: ['clay'] } }] })).toBe(true);
    expect(
      canPutBack({ tool: 'finish_queued', notes: [{ before: { sendState: 'queued' } }] }),
    ).toBe(true);
    expect(canPutBack({ tool: 'refile', notes: [{ before: {} }, {}] })).toBe(false);
  });
});

describe('rerouteNotes (#235)', () => {
  const none = () => false;

  it('files the originals a merge put back restores', () => {
    const merge = {
      tool: 'merge_notes',
      summary: 'Merged 2 notes into one',
      notes: [{ id: 'm' }, { id: 'a' }, { id: 'b' }],
    };
    expect(rerouteNotes(merge, none)).toEqual(['a', 'b']);
  });

  it('files a project a refile filed under another, but not one it tagged', () => {
    expect(
      rerouteNotes(
        {
          tool: 'refile',
          summary: 'Refiled Glazes: filed under Pottery',
          notes: [{ id: 'g', before: { parent: null } }],
        },
        none,
      ),
    ).toEqual(['g']);
    expect(
      rerouteNotes(
        {
          tool: 'refile',
          summary: 'Refiled Firing notes: tagged kiln',
          notes: [{ id: 'f', before: { tags: [] } }],
        },
        none,
      ),
    ).toEqual([]);
    // Moved to the top level is no filing under a project.
    expect(
      rerouteNotes(
        {
          tool: 'refile',
          summary: 'Refiled Glazes: moved to the top level',
          notes: [{ id: 'g', before: { parent: 'c-pottery' } }],
        },
        none,
      ),
    ).toEqual([]);
  });

  it('files a note linked to a project, not one linked to a person', () => {
    const link = {
      tool: 'link_notes',
      summary: 'Linked a note to 1 other',
      notes: [{ id: 'n' }, { id: 'c-pottery' }],
    };
    expect(rerouteNotes(link, (id) => id === 'c-pottery')).toEqual(['n']);
    expect(rerouteNotes(link, none)).toEqual([]);
  });

  it('files again what a reroute filed, and nothing for a text edit', () => {
    expect(
      rerouteNotes(
        { tool: 'reroute', summary: 'Filed Kiln under Pottery', notes: [{ id: 'k' }] },
        none,
      ),
    ).toEqual(['k']);
    expect(
      rerouteNotes(
        { tool: 'add_lines', summary: 'Added 1 line to Kiln', notes: [{ id: 'k' }] },
        none,
      ),
    ).toEqual([]);
    expect(rerouteNotes({ tool: 'merge_notes', summary: '', notes: [] }, none)).toEqual([]);
  });

  it('derives the reroute id, and its record can be put back', () => {
    expect(rerouteId('putback-r1')).toBe('reroute-putback-r1');
    expect(canPutBack({ tool: 'reroute', notes: [{ before: { links: [] } }] })).toBe(true);
    expect(canPutBack({ tool: 'reroute', notes: [{}] })).toBe(false);
  });
});
