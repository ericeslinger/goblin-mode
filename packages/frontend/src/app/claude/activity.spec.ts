import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW, TIME_ZONE } from '../platform/platform';
import {
  FakeAuthService,
  FakeModules,
  FakeNotes,
  FakeProposals,
  fakeFirebase,
  noteRecord,
} from '../testing/fakes';
import { ACTIVITY_API, Activity, type ActivityApi, digestLine, toRun } from './activity';
import { type ProposalRecord, ProposalsService } from './proposals.service';

const at = (ms: number) => ({ toMillis: () => ms });

// Long after the runs below, so no digest shows unless a spec asks.
const LATER = Date.parse('2026-12-01T15:00:00Z');

async function render(suggestions: ProposalRecord[] = [], now = LATER) {
  let push: Parameters<ActivityApi['listen']>[2] = () => undefined;
  const api = {
    listen: vi.fn((_db, _path, next) => {
      push = next;
      return vi.fn();
    }),
  } satisfies ActivityApi;
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1' } as User);
  const notes = new FakeNotes();
  notes.signIn([
    { ...noteRecord('m1', 'Kiln log, merged'), title: 'Kiln log' },
    { ...noteRecord('a', 'Firing notes'), archived: true },
    { ...noteRecord('p', 'Pottery'), kind: 'concept', conceptType: 'project' },
  ]);
  const proposals = new FakeProposals();
  proposals.list.set(suggestions);
  await TestBed.configureTestingModule({
    imports: [Activity],
    providers: [
      provideRouter([]),
      { provide: ACTIVITY_API, useValue: api },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
      { provide: ModulesService, useValue: new FakeModules() },
      { provide: ProposalsService, useValue: proposals },
      { provide: NOW, useValue: () => now },
      { provide: TIME_ZONE, useValue: 'America/New_York' },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Activity);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    el,
    api,
    auth,
    fixture,
    proposals,
    async push(docs: { id: string; data: Record<string, unknown> }[]) {
      push(docs);
      await fixture.whenStable();
    },
  };
}

describe('Activity', () => {
  it("listens to the owner's runs, loading first, then says when there are none", async () => {
    const { el, api, push } = await render();
    expect(api.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/activity',
      expect.any(Function),
      expect.any(Function),
    );
    expect(el.textContent).toContain('Loading…');
    await push([]);
    expect(el.textContent).toContain('Nothing yet.');
  });

  it('lists each run with the notes it touched, their History, and reminders', async () => {
    const { el, push } = await render();
    await push([
      {
        id: 'r2',
        data: {
          at: at(Date.parse('2026-10-07T03:00:00Z')),
          tool: 'merge_notes',
          summary: 'Merged 2 notes into one',
          notes: [
            { id: 'm1', title: 'Kiln' },
            { id: 'a', title: 'Firing notes' },
          ],
          reminders: [],
        },
      },
      {
        id: 'r1',
        data: {
          at: at(Date.parse('2026-10-07T02:00:00Z')),
          tool: 'create_reminder',
          summary: 'Made a reminder',
          notes: [],
          reminders: [{ id: 'x', title: 'Water seeds' }],
        },
      },
    ]);
    const runs = [...el.querySelectorAll('.runs > li')];
    expect(runs).toHaveLength(2);
    expect(runs[0].querySelector('.summary')?.textContent).toContain('Merged 2 notes into one');
    const links = [...runs[0].querySelectorAll('a')].map((a) => [
      a.textContent?.trim(),
      a.getAttribute('href'),
    ]);
    // The title now, not as it was; an archived original says so.
    expect(links).toEqual([
      ['Kiln log', '/n/m1'],
      ['History of Kiln log', '/history?note=m1'],
      ['Firing notes', '/n/a'],
      ['History of Firing notes', '/history?note=a'],
    ]);
    expect(runs[0].textContent).toContain('archived');
    // Show changes (#241) for the note the merge wrote, not its original.
    expect(
      [...runs[0].querySelectorAll('app-run-changes button')].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Show changes: Kiln log']);
    expect(runs[1].querySelector('a')?.getAttribute('href')).toBe('/right-now');
    expect(runs[1].textContent).toContain('Water seeds');
  });

  it('offers Put back on runs that touched notes, and marks one put back (#154)', async () => {
    const { el, push } = await render();
    await push([
      {
        id: 'putback-r2',
        data: {
          at: at(Date.parse('2026-10-07T04:00:00Z')),
          tool: 'put_back',
          summary: 'Put back “Merged 2 notes into one”',
          notes: [{ id: 'm1', title: 'Kiln' }],
          reminders: [],
          agent: 'Mossgoblin',
        },
      },
      {
        id: 'r2',
        data: {
          at: at(Date.parse('2026-10-07T03:00:00Z')),
          tool: 'merge_notes',
          summary: 'Merged 2 notes into one',
          notes: [{ id: 'm1', title: 'Kiln' }],
          reminders: [],
        },
      },
      {
        id: 'r3',
        data: {
          at: at(Date.parse('2026-10-07T02:30:00Z')),
          tool: 'refile',
          summary: 'Filed a note as a person',
          notes: [{ id: 'm1', title: 'Kiln' }],
          reminders: [],
        },
      },
      {
        id: 'r4',
        data: {
          at: at(Date.parse('2026-10-07T02:15:00Z')),
          tool: 'refile',
          summary: 'Refiled Kiln: tagged pottery',
          notes: [{ id: 'm1', title: 'Kiln', before: { tags: [] } }],
          reminders: [],
        },
      },
      {
        id: 'r1',
        data: {
          at: at(Date.parse('2026-10-07T02:00:00Z')),
          tool: 'create_reminder',
          summary: 'Made a reminder',
          notes: [],
          reminders: [{ id: 'x', title: 'Water seeds' }],
        },
      },
    ]);
    const runs = [...el.querySelectorAll('.runs > li')];
    const putBack = (li: Element) => li.querySelector('app-put-back');
    // The put back is a run too, by Mossgoblin, and can itself be put back.
    expect(runs[0].textContent).toContain('Mossgoblin:');
    expect(putBack(runs[0])?.querySelector('button')?.textContent).toContain('Put back');
    // The merge it put back says so, with no button.
    expect(putBack(runs[1])?.querySelector('button')).toBeNull();
    expect(putBack(runs[1])?.textContent?.trim()).toBe('Put back');
    // Filing from before its record kept the fields it changed, and
    // reminders, are not to put back; filing that kept them is (#206).
    expect(putBack(runs[2])).toBeNull();
    expect(putBack(runs[3])?.querySelector('button')?.textContent).toContain('Put back');
    expect(putBack(runs[4])).toBeNull();
  });

  it('stops listening when the owner signs out', async () => {
    const { api, auth, fixture } = await render();
    const stop = api.listen.mock.results[0].value as ReturnType<typeof vi.fn>;
    auth.user.set(null);
    await fixture.whenStable();
    expect(stop).toHaveBeenCalled();
  });

  it('shows each suggestion in words, with Accept and Dismiss, and what became of it', async () => {
    const { el, proposals, fixture } = await render([
      {
        id: 'p1',
        kind: 'merge',
        reason: 'Both are the same firing.',
        notes: [
          { id: 'm1', title: 'Kiln' },
          { id: 'a', title: 'Firing notes' },
        ],
        status: 'open',
      },
      {
        id: 'p2',
        kind: 'refile',
        reason: 'He is a person.',
        notes: [{ id: 'c-vikas', title: 'Vikas' }],
        conceptType: 'person',
        synonyms: ['Vik'],
        status: 'failed',
        outcome: 'no note c-vikas',
      },
      {
        id: 'p3',
        kind: 'link',
        reason: 'Same kiln.',
        notes: [
          { id: 'm1', title: 'Kiln' },
          { id: 'a', title: 'Firing notes' },
        ],
        status: 'applying',
      },
    ]);
    const list = el.querySelector('[aria-label="Suggestions"]')!;
    const items = [...list.querySelectorAll(':scope > li')];
    const flat = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
    expect(flat(items[0].querySelector('.what')!)).toBe(
      'Merge Kiln log, Firing notes into one note',
    );
    expect(flat(items[0])).toContain('Both are the same firing.');
    expect(flat(items[1].querySelector('.what')!)).toBe('File Vikas as a person and call it Vik');
    expect(flat(items[1])).toContain('Could not do this: no note c-vikas');
    expect(flat(items[2].querySelector('.what')!)).toBe('Link Kiln log to Firing notes');
    expect(flat(items[2])).toContain('Accepted. Claude is on it.');
    const buttons = [...items[0].querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Accept', 'Dismiss']);
    expect(buttons[0].getAttribute('aria-describedby')).toBe('proposal-p1');
    buttons[0].click();
    buttons[1].click();
    await fixture.whenStable();
    expect(proposals.accept).toHaveBeenCalledWith('p1');
    expect(proposals.dismiss).toHaveBeenCalledWith('p1');
    expect(items[1].querySelector('button')).toBeNull();
  });

  it('shows a sealed suggestion with a calm line in place of its reason (step 3e)', async () => {
    const { el } = await render([
      {
        id: 'p1',
        kind: 'merge',
        reason: '',
        notes: [
          { id: 'm1', title: 'Sealed note' },
          { id: 'a', title: 'Sealed note' },
        ],
        status: 'open',
        sealed: true,
      },
    ]);
    const item = el.querySelector('[aria-label="Suggestions"] > li')!;
    const flat = item.textContent!.replace(/\s+/g, ' ').trim();
    // The notes by their own titles, the reason as sealed, no sealed text.
    expect(flat).toContain('Merge Kiln log, Firing notes into one note');
    expect(flat).toContain('This suggestion is sealed, and its key is not on this device yet.');
    expect(flat).not.toContain('\uE000');
  });

  it("says yesterday's gardening in one line above the changes, not today's (#237)", async () => {
    // 2026-11-09 09:00 in New York.
    const { el, push } = await render([], Date.parse('2026-11-09T14:00:00Z'));
    const run = (id: string, iso: string, tool: string, summary: string, notes: object[]) => ({
      id,
      data: { at: at(Date.parse(iso)), tool, summary, notes, reminders: [] },
    });
    await push([
      // Today, on New York's clock: not in yesterday's line.
      run('t1', '2026-11-09T06:00:00Z', 'create_note', 'Wrote a new note', [
        { id: 'n', title: 'Today', made: true },
      ]),
      run('y3', '2026-11-09T04:00:00Z', 'link_notes', 'Linked a note to 1 other', [
        { id: 'g', title: 'Glazes' },
        { id: 'p', title: 'Pottery' },
      ]),
      run('y2', '2026-11-08T15:00:00Z', 'add_lines', 'Added 2 lines to Kiln log', [
        { id: 'm1', title: 'Kiln log' },
      ]),
      run('y1', '2026-11-08T06:00:00Z', 'create_note', 'Wrote a new note', [
        { id: 'x', title: 'Gift ideas', made: true },
      ]),
      // The day before yesterday.
      run('old', '2026-11-08T04:00:00Z', 'create_note', 'Wrote a new note', [
        { id: 'o', title: 'Older', made: true },
      ]),
    ]);
    const digest = el.querySelector('section.digest')!;
    expect(digest.getAttribute('aria-labelledby')).toBe('digest');
    expect(digest.querySelector('h2')?.textContent).toBe('The day in one line');
    expect(digest.querySelector('p')?.textContent?.trim()).toBe(
      'Yesterday: 1 note filed under Pottery, 2 lines added to Kiln log, Gift ideas made.',
    );
    // Above the list.
    expect(
      digest.compareDocumentPosition(el.querySelector('.runs')!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('says today so far when yesterday had nothing, and nothing when neither had', async () => {
    const now = Date.parse('2026-11-09T14:00:00Z');
    const runs = [
      toRun('t1', {
        at: at(Date.parse('2026-11-09T13:00:00Z')),
        tool: 'put_back',
        summary: 'Put back “x”',
        notes: [{ id: 'a', title: 'A' }],
      }),
    ];
    const no = () => false;
    expect(digestLine(runs, now, 'America/New_York', no)).toBe(
      'Today so far: you put back 1 change.',
    );
    expect(digestLine([], now, 'America/New_York', no)).toBeUndefined();
    const { el, push } = await render([], now);
    await push([]);
    expect(el.querySelector('section.digest')).toBeNull();
  });

  it('shows no Suggestions heading when there are none', async () => {
    const { el } = await render();
    expect(el.textContent).not.toContain('Suggestions');
  });
});
