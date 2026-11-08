import { describe, expect, it } from 'vitest';
import {
  type NoteFacts,
  type RunFacts,
  RUN_SLACK_MS,
  didOf,
  nothingToPutBack,
  planPutBack,
  putBackSummary,
} from './plan';

const T = Date.parse('2026-11-08T10:00:00Z');
const DAY = 86_400_000;

const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  id: 'r1',
  at: T,
  tool: 'add_lines',
  summary: 'Added 1 line to Shopping',
  device: 'claude',
  notes: [{ id: 'a', title: 'Shopping' }],
  ...over,
});

const note = (id: string, over: Partial<NoteFacts> = {}): NoteFacts => ({
  id,
  body: `${id} body`,
  title: id,
  titleSource: 'user',
  archived: false,
  createdAt: T - DAY,
  updatedAt: T,
  deviceId: 'claude',
  ...over,
});

const notes = (...ns: NoteFacts[]) => new Map(ns.map((n) => [n.id, n]));

describe('didOf', () => {
  it('reads a merge, a made note, an archive and an edit from the run', () => {
    expect(
      didOf(
        run({
          tool: 'merge_notes',
          notes: [
            { id: 'm', title: '' },
            { id: 'x', title: '' },
          ],
        }),
        notes(),
      ),
    ).toEqual(
      new Map([
        ['m', { kind: 'merged' }],
        ['x', { kind: 'original', into: 'm' }],
      ]),
    );
    // A split: the note keeps its first part; the pieces were made then.
    expect(
      didOf(
        run({
          tool: 'split_note',
          notes: [
            { id: 'a', title: '' },
            { id: 'p', title: '' },
          ],
        }),
        notes(note('a'), note('p', { createdAt: T - 2 })),
      ),
    ).toEqual(
      new Map<string, unknown>([
        ['a', { kind: 'edited', text: true }],
        ['p', { kind: 'created' }],
      ]),
    );
    expect(didOf(run({ tool: 'archive_note', summary: 'Archived a note' }), notes())).toEqual(
      new Map([['a', { kind: 'edited', flip: 'archived', text: false }]]),
    );
    expect(
      didOf(run({ tool: 'update_note', summary: "Changed a note's title and tags" }), notes()),
    ).toEqual(new Map([['a', { kind: 'edited', text: false }]]));
    expect(
      didOf(
        run({ tool: 'update_note', summary: "Changed a note's text; Restored a note" }),
        notes(),
      ),
    ).toEqual(new Map([['a', { kind: 'edited', flip: 'restored', text: true }]]));
  });
});

describe('planPutBack', () => {
  it('writes back the text the run wrote over, verbatim, with its first-words title', () => {
    const a = note('a', { body: 'Shopping\n- [ ] limes', titleSource: 'words', baseHash: 'h' });
    const plan = planPutBack({
      run: run(),
      base: run(),
      depth: 0,
      notes: notes(a),
      textBefore: new Map([['a', 'Shopping list\n']]),
    });
    expect(plan).toEqual({
      writes: [
        { id: 'a', title: 'Shopping list', body: 'Shopping list\n', newTitle: 'Shopping list' },
      ],
      skipped: [],
    });
  });

  it('keeps a title Eric set', () => {
    const plan = planPutBack({
      run: run(),
      base: run(),
      depth: 0,
      notes: notes(note('a', { title: 'Mine' })),
      textBefore: new Map([['a', 'before']]),
    });
    expect(plan.writes).toEqual([{ id: 'a', title: 'Mine', body: 'before' }]);
  });

  it('leaves a note written since alone, and one the run only named', () => {
    const r = run({
      tool: 'link_notes',
      notes: [
        { id: 'a', title: 'From' },
        { id: 'b', title: 'Target' },
      ],
    });
    const plan = planPutBack({
      run: r,
      base: r,
      depth: 0,
      notes: notes(
        note('a', { updatedAt: T + 1, deviceId: 'phone' }),
        note('b', { updatedAt: T - DAY, deviceId: 'phone' }),
      ),
      textBefore: new Map([['a', 'before']]),
    });
    expect(plan).toEqual({ writes: [], skipped: [{ id: 'a', title: 'a', why: 'changed' }] });
    expect(nothingToPutBack(plan)).toMatch(/changed since/);
  });

  it('counts a write stamped a moment before the record as the run’s own', () => {
    const plan = planPutBack({
      run: run(),
      base: run(),
      depth: 0,
      notes: notes(note('a', { updatedAt: T - RUN_SLACK_MS })),
      textBefore: new Map([['a', 'before']]),
    });
    expect(plan.writes).toHaveLength(1);
    // Another assistant's write is not this run's.
    const other = planPutBack({
      run: run(),
      base: run(),
      depth: 0,
      notes: notes(note('a', { deviceId: 'agent:Gemini CLI' })),
      textBefore: new Map([['a', 'before']]),
    });
    expect(other.writes).toEqual([]);
  });

  it('archives a note the run made, never deleting it', () => {
    const r = run({ tool: 'create_note', summary: 'Wrote a new note' });
    const plan = planPutBack({
      run: r,
      base: r,
      depth: 0,
      notes: notes(note('a', { createdAt: T })),
      textBefore: new Map(),
    });
    expect(plan.writes).toEqual([{ id: 'a', title: 'a', archived: true }]);
  });

  it('brings back a merge’s originals and archives the merged note', () => {
    const r = run({
      tool: 'merge_notes',
      summary: 'Merged 2 notes into one',
      notes: [
        { id: 'm', title: 'Kiln' },
        { id: 'x', title: 'Kiln' },
        { id: 'y', title: 'Firing' },
      ],
    });
    const plan = planPutBack({
      run: r,
      base: r,
      depth: 0,
      notes: notes(
        note('m', { createdAt: T - DAY }),
        note('x', { archived: true, mergedInto: 'm' }),
        note('y', { archived: true, mergedInto: 'm' }),
      ),
      textBefore: new Map(),
    });
    expect(plan.writes).toEqual([
      { id: 'm', title: 'm', archived: true },
      { id: 'x', title: 'x', archived: false, mergedInto: null },
      { id: 'y', title: 'y', archived: false, mergedInto: null },
    ]);
  });

  it('unarchives what the run archived, and says when History lost the text', () => {
    const r = run({ tool: 'update_note', summary: "Changed a note's text; Archived a note" });
    const plan = planPutBack({
      run: r,
      base: r,
      depth: 0,
      notes: notes(note('a', { archived: true, baseHash: 'gone' })),
      textBefore: new Map(),
    });
    expect(plan.writes).toEqual([{ id: 'a', title: 'a', archived: false }]);
    expect(putBackSummary(r, plan)).toBe(
      "Put back “Changed a note's text; Archived a note”; History no longer had the text before for a note",
    );
  });

  it('puts back a put back by doing the run again', () => {
    const base = run({
      tool: 'merge_notes',
      summary: 'Merged 2 notes into one',
      at: T - DAY,
      notes: [
        { id: 'm', title: 'Kiln' },
        { id: 'x', title: 'Kiln' },
      ],
    });
    const back = run({
      id: 'putback-r1',
      tool: 'put_back',
      summary: 'Put back “Merged 2 notes into one”',
      device: 'agent:Mossgoblin~putback-r1',
      notes: [
        { id: 'm', title: 'Kiln' },
        { id: 'x', title: 'Kiln' },
      ],
    });
    const plan = planPutBack({
      run: back,
      base,
      depth: 1,
      notes: notes(
        note('m', { archived: true, deviceId: back.device }),
        note('x', { deviceId: back.device }),
      ),
      textBefore: new Map(),
    });
    expect(plan.writes).toEqual([
      { id: 'm', title: 'm', archived: false },
      { id: 'x', title: 'x', archived: true, mergedInto: 'm' },
    ]);
  });

  it('puts back a put back’s text from what it wrote over', () => {
    const back = run({ id: 'putback-r1', tool: 'put_back', device: 'pb' });
    const plan = planPutBack({
      run: back,
      base: run({ at: T - DAY }),
      depth: 1,
      notes: notes(note('a', { body: 'before', deviceId: 'pb', createdAt: T - 2 * DAY })),
      textBefore: new Map([['a', 'after the run']]),
    });
    expect(plan.writes).toEqual([{ id: 'a', title: 'a', body: 'after the run' }]);
  });

  it('writes nothing for a note already as the put back would leave it', () => {
    const plan = planPutBack({
      run: run(),
      base: run(),
      depth: 0,
      notes: notes(note('a', { body: 'same' })),
      textBefore: new Map([['a', 'same']]),
    });
    expect(plan).toEqual({ writes: [], skipped: [] });
    expect(nothingToPutBack(plan)).toBe('Nothing it changed is left to put back.');
  });

  it('names a note gone since', () => {
    const plan = planPutBack({
      run: run(),
      base: run(),
      depth: 0,
      notes: notes(),
      textBefore: new Map(),
    });
    expect(plan.skipped).toEqual([{ id: 'a', title: 'Shopping', why: 'gone' }]);
  });
});
