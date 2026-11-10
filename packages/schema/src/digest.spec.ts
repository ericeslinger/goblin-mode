import { describe, expect, it } from 'vitest';
import { type DigestRecord, digestSentence, yesterdayIn } from './digest';
import { zonedDay, zonedDayStart, zonedHour } from './reminders';

const FROM = Date.parse('2026-11-08T00:00:00Z');
const TO = Date.parse('2026-11-09T00:00:00Z');
const DAY = { from: FROM, to: TO };
const noon = FROM + 12 * 3_600_000;

let n = 0;
const rec = (
  tool: string,
  summary: string,
  notes: DigestRecord['notes'] = [],
  at = noon + n++,
): DigestRecord => ({ tool, summary, notes, at });
const note = (id: string, title: string, extra: object = {}) => ({ id, title, ...extra });

describe('digestSentence', () => {
  it('says nothing when the day had no records', () => {
    expect(digestSentence([], DAY)).toBeUndefined();
  });

  it('leaves out records of other days, the end of the day included, and ones with no time', () => {
    const records = [
      rec('create_note', 'Wrote a new note', [note('a', 'Before', { made: true })], FROM - 1),
      rec('create_note', 'Wrote a new note', [note('b', 'After', { made: true })], TO),
      { tool: 'create_note', summary: 'Wrote a new note', notes: [note('c', 'Undated')] },
    ];
    expect(digestSentence(records, DAY)).toBeUndefined();
    expect(
      digestSentence(
        [rec('create_note', 'Wrote a new note', [note('d', 'Start', { made: true })], FROM)],
        DAY,
      ),
    ).toBe('Yesterday: Start made.');
  });

  it('groups filing under each project, counting notes, most first', () => {
    const records = [
      rec('refile', 'Refiled Glazes: filed under Pottery', [
        note('g', 'Glazes', { before: { parent: null } }),
      ]),
      rec('refile', 'Refiled Kilns: filed under Pottery; stage Doing', [
        note('k', 'Kilns', { before: { parent: null } }),
      ]),
      rec('refile', 'Refiled Clay: filed under Pottery', [
        note('c', 'Clay', { before: { parent: null } }),
      ]),
      rec('refile', 'Refiled Q4: filed under Work', [
        note('q', 'Q4', { before: { parent: null } }),
      ]),
      // The same note filed twice is one note.
      rec('refile', 'Refiled Clay: filed under pottery', [
        note('c', 'Clay', { before: { parent: 'x' } }),
      ]),
    ];
    expect(digestSentence(records, DAY)).toBe(
      'Yesterday: 3 notes filed under Pottery, 1 note filed under Work.',
    );
  });

  it('reads a link to a project as filing under it, and any other link as a link', () => {
    const isProject = (id: string) => id === 'p';
    const records = [
      rec('link_notes', 'Linked a note to 1 other', [
        note('a', 'Glaze test'),
        note('p', 'Pottery'),
      ]),
      rec('link_notes', 'Linked a note to 1 other', [note('b', 'Recipe'), note('c', 'Dinner')]),
    ];
    expect(digestSentence(records, { ...DAY, isProject })).toBe(
      'Yesterday: 1 note filed under Pottery, Recipe linked.',
    );
    expect(digestSentence(records, DAY)).toBe('Yesterday: Glaze test and Recipe linked.');
  });

  it('counts an idea gardened under a project as filed, not also made', () => {
    const records = [
      rec('capture', 'Wrote a new note', [note('i', 'Bigger kiln', { made: true })]),
      rec('capture', 'Gardened an idea under Pottery: Bigger kiln', [note('p', 'Pottery')]),
    ];
    expect(digestSentence(records, DAY)).toBe('Yesterday: 1 note filed under Pottery.');
  });

  it('sums the lines added to each note, a line in the singular', () => {
    const records = [
      rec('add_lines', 'Added 2 lines to Kiln log', [note('k', 'Kiln log')]),
      rec('add_lines', 'Added 3 lines to Kiln log, under Firings', [note('k', 'Kiln log')]),
      rec('add_lines', 'Added 1 line to Q4 plan', [note('q', 'Q4 plan')]),
    ];
    expect(digestSentence(records, DAY)).toBe(
      'Yesterday: 5 lines added to Kiln log, a line added to Q4 plan.',
    );
  });

  it('names notes made, two at most, then counts them', () => {
    const made = (id: string, title: string, tool = 'create_note') =>
      rec(tool, 'Wrote a new note', [note(id, title, { made: true })]);
    expect(digestSentence([made('a', 'Gift ideas')], DAY)).toBe('Yesterday: Gift ideas made.');
    expect(digestSentence([made('a', 'Gift ideas'), made('b', 'Pie', 'create_recipe')], DAY)).toBe(
      'Yesterday: Gift ideas and Pie made.',
    );
    expect(
      digestSentence([made('a', 'Gift ideas'), made('b', 'Pie'), made('c', 'Journal')], DAY),
    ).toBe('Yesterday: 3 notes made.');
  });

  it('says merges and splits with their counts, and not their notes as made', () => {
    const records = [
      rec('merge_notes', 'Merged 2 notes into one', [
        note('m', 'Kiln log', { made: true }),
        note('a', 'Kiln'),
        note('b', 'Firing notes'),
      ]),
      rec('split_note', 'Split a note into 3', [
        note('r', 'Ramble'),
        note('p1', 'One', { made: true }),
        note('p2', 'Two', { made: true }),
      ]),
    ];
    expect(digestSentence(records, DAY)).toBe(
      'Yesterday: 2 notes merged into Kiln log, Ramble split into 3.',
    );
  });

  it('says edits, archiving, restoring, other filing and answered items', () => {
    const records = [
      rec('update_note', "Changed a note's text", [note('q', 'Q4 plan')]),
      rec('update_note', "Changed a note's tags; Archived a note", [note('o', 'Old list')]),
      rec('archive_note', 'Restored a note', [note('r', 'Recipes')]),
      rec('refile', 'Refiled Pottery: tagged craft', [
        note('p', 'Pottery', { before: { tags: [] } }),
      ]),
      rec('answer_item', 'Answered an item in Gift ideas', [note('g', 'Gift ideas')]),
    ];
    expect(digestSentence(records, DAY)).toBe(
      'Yesterday: Q4 plan and Old list edited, an item answered in Gift ideas, Pottery refiled, Old list archived, and 1 more change.',
    );
  });

  it('caps the parts and counts what is left as changes', () => {
    const records = [
      rec('refile', 'Refiled A: filed under Pottery', [
        note('a', 'A', { before: { parent: null } }),
      ]),
      rec('add_lines', 'Added 2 lines to Kiln log', [note('k', 'Kiln log')]),
      rec('create_note', 'Wrote a new note', [note('g', 'Gift ideas', { made: true })]),
      rec('update_note', "Changed a note's text", [note('q', 'Q4 plan')]),
      rec('archive_note', 'Archived a note', [note('o', 'Old')]),
      rec('archive_note', 'Archived a note', [note('o2', 'Older')]),
      rec('plan_meal', 'Planned Mon dinner: Pie', []),
    ];
    expect(digestSentence(records, DAY)).toBe(
      'Yesterday: 1 note filed under Pottery, 2 lines added to Kiln log, Gift ideas made, Q4 plan edited, and 3 more changes.',
    );
  });

  it('counts tools it has no words for as changes', () => {
    expect(
      digestSentence(
        [rec('plan_meal', 'Planned Mon dinner: Pie'), rec('check_item', 'Ticked eggs')],
        DAY,
      ),
    ).toBe('Yesterday: 2 changes.');
    expect(
      digestSentence(
        [
          rec('plan_meal', 'Planned Mon dinner: Pie'),
          rec('create_note', 'Wrote a new note', [note('g', 'Gift ideas', { made: true })]),
        ],
        DAY,
      ),
    ).toBe('Yesterday: Gift ideas made, 1 other change.');
  });

  it("says Eric's own put backs and filing again as his, after the assistants' work", () => {
    const records = [
      rec('refile', 'Refiled A: filed under Pottery', [
        note('a', 'A', { before: { parent: null } }),
      ]),
      rec('put_back', 'Put back “Refiled A: filed under Pottery”', [note('a', 'A')]),
      rec('reroute', 'Filed A under Garden', [note('a', 'A', { before: { parent: null } })]),
    ];
    expect(digestSentence(records, DAY)).toBe(
      'Yesterday: 1 note filed under Pottery; you put back 1 change and filed a note again.',
    );
    expect(
      digestSentence(
        [
          rec('put_back', 'Put back “x”', [note('a', 'A')]),
          rec('put_back', 'Put back “y”', [note('b', 'B')]),
        ],
        DAY,
      ),
    ).toBe('Yesterday: you put back 2 changes.');
    expect(
      digestSentence(
        [rec('reroute', 'Filed 2 notes under Garden', [note('a', 'A'), note('b', 'B')])],
        DAY,
      ),
    ).toBe('Yesterday: you filed 2 notes again.');
  });

  it('takes its label, and cuts a long title', () => {
    const long = 'A very long title that goes on and on about the kiln';
    expect(
      digestSentence([rec('create_note', 'Wrote a new note', [note('a', long, { made: true })])], {
        ...DAY,
        label: 'Today so far',
      }),
    ).toBe('Today so far: A very long title that goes on and on a… made.');
    expect(
      digestSentence(
        [rec('create_note', 'Wrote a new note', [note('a', ' ', { made: true })])],
        DAY,
      ),
    ).toBe('Yesterday: Untitled made.');
  });
});

describe('yesterdayIn and the zoned days', () => {
  it('gives the day before, from midnight to midnight on the local clock', () => {
    // 2026-11-09 01:30 in New York is 06:30 UTC.
    const now = Date.parse('2026-11-09T06:30:00Z');
    expect(yesterdayIn(now, 'America/New_York')).toEqual({
      day: '2026-11-08',
      today: '2026-11-09',
      from: Date.parse('2026-11-08T05:00:00Z'),
      to: Date.parse('2026-11-09T05:00:00Z'),
    });
    expect(yesterdayIn(now, 'UTC')).toEqual({
      day: '2026-11-08',
      today: '2026-11-09',
      from: Date.parse('2026-11-08T00:00:00Z'),
      to: Date.parse('2026-11-09T00:00:00Z'),
    });
  });

  it('keeps a day across a clock change its own length', () => {
    // New York left daylight time on 2026-11-01: that day ran 25 hours.
    const start = zonedDayStart('2026-11-01', 'America/New_York');
    const end = zonedDayStart('2026-11-02', 'America/New_York');
    expect(start).toBe(Date.parse('2026-11-01T04:00:00Z'));
    expect(end - start).toBe(25 * 3_600_000);
  });

  it('reads the local day and hour of an instant', () => {
    const t = Date.parse('2026-11-09T03:15:00Z');
    expect(zonedDay(t, 'America/Los_Angeles')).toBe('2026-11-08');
    expect(zonedHour(t, 'America/Los_Angeles')).toBe(19);
    expect(zonedDay(t, 'Asia/Tokyo')).toBe('2026-11-09');
    expect(zonedHour(t, 'Asia/Tokyo')).toBe(12);
  });
});
