import { TestBed } from '@angular/core/testing';
import { ModulesService } from '../modules/modules.service';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import { ONLINE } from '../platform/platform';
import { FakeModules, FakeNotes, noteRecord } from '../testing/fakes';
import type { RunRecord } from './activity';
import { PUT_BACK_API, PutBack, type PutBackApi, rerouteChoices } from './put-back';

const run: RunRecord = {
  id: 'r1',
  at: 1,
  agent: 'Claude',
  tool: 'merge_notes',
  summary: 'Merged 2 notes into one',
  notes: [
    { id: 'm', title: 'Kiln' },
    { id: 'a', title: 'Kiln' },
    { id: 'b', title: 'Firing' },
  ],
  reminders: [],
};

const project = (id: string, title: string, over: Partial<NoteRecord> = {}): NoteRecord => ({
  ...noteRecord(id, title),
  kind: 'concept',
  conceptType: 'project',
  ...over,
});

/** Pottery and Garden active, Old done, Kiln a plain note. */
const garden = [
  project('c-pottery', 'Pottery'),
  project('c-garden', 'Garden', { projectStatus: 'active' }),
  project('c-old', 'Old', { projectStatus: 'done' }),
  noteRecord('k', 'Kiln log'),
];

/** An assistant linked Kiln log to Pottery. */
const linked: RunRecord = {
  id: 'r2',
  at: 1,
  agent: 'Claude',
  tool: 'link_notes',
  summary: 'Linked a note to 1 other',
  notes: [
    { id: 'k', title: 'Kiln log' },
    { id: 'c-pottery', title: 'Pottery' },
  ],
  reminders: [],
};

async function render(
  opts: {
    online?: boolean;
    done?: boolean;
    api?: Partial<PutBackApi>;
    run?: RunRecord;
    notes?: NoteRecord[];
    projects?: boolean;
  } = {},
) {
  let online = opts.online ?? true;
  const api = {
    revert: vi.fn(async (runId: string) => ({
      status: 'done' as const,
      id: `putback-${runId}`,
      notes: 3,
    })),
    reroute: vi.fn(async (runId: string, _projectId: string) => ({
      status: 'done' as const,
      id: `reroute-${runId}`,
      notes: 1,
    })),
    ...opts.api,
  };
  const notes = new FakeNotes();
  notes.signIn(opts.notes ?? []);
  const modules = new FakeModules();
  if (opts.projects === false) modules.set('projects', false);
  await TestBed.configureTestingModule({
    imports: [PutBack],
    providers: [
      { provide: PUT_BACK_API, useValue: api },
      { provide: ONLINE, useValue: () => online },
      { provide: NotesService, useValue: notes },
      { provide: ModulesService, useValue: modules },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(PutBack);
  fixture.componentRef.setInput('run', opts.run ?? run);
  fixture.componentRef.setInput('done', opts.done ?? false);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (name: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent!.trim().startsWith(name))!;
  const text = () => el.textContent!.replace(/\s+/g, ' ').trim();
  return {
    el,
    api,
    fixture,
    button,
    text,
    modules,
    goOffline: () => (online = false),
    async click(name: string) {
      button(name).click();
      await fixture.whenStable();
    },
  };
}

describe('PutBack (#154 step 1)', () => {
  it('asks in one line, then puts the run back and says how many notes', async () => {
    const { api, click, text, button } = await render();
    expect(button('Put back').getAttribute('aria-label')).toBe('Put back: Merged 2 notes into one');
    await click('Put back');
    expect(text()).toContain('Put back 3 notes?');
    expect(api.revert).not.toHaveBeenCalled();
    await click('Yes');
    expect(api.revert).toHaveBeenCalledWith('r1');
    expect(text()).toContain('Put back 3 notes.');
  });

  it('says No without calling, and Already put back when the server says so', async () => {
    const { api, click, text } = await render({
      api: { revert: vi.fn(async () => ({ status: 'already' as const, id: 'x', notes: 0 })) },
    });
    await click('Put back');
    await click('No');
    expect(text()).not.toContain('?');
    expect(api.revert).not.toHaveBeenCalled();
    await click('Put back');
    await click('Yes');
    expect(text()).toContain('Already put back.');
  });

  it('says why the server refused', async () => {
    const { click, text } = await render({
      api: {
        revert: vi.fn(async () => {
          throw new Error('Its notes have changed since.');
        }),
      },
    });
    await click('Put back');
    await click('Yes');
    expect(text()).toContain('Could not put back: Its notes have changed since.');
  });

  it('says it needs the network when offline, without calling', async () => {
    const { api, click, text, goOffline } = await render();
    goOffline();
    await click('Put back');
    expect(text()).toContain('Putting back needs the network.');
    expect(text()).not.toContain('?');
    expect(api.revert).not.toHaveBeenCalled();
  });

  it('shows a run already put back as done, with no button', async () => {
    const { el, text } = await render({ done: true });
    expect(el.querySelector('button')).toBeNull();
    expect(text()).toBe('Put back');
  });
});

describe('File it under… (#235)', () => {
  it('offers the active projects once a filing is put back, and files under the one picked', async () => {
    const { api, click, text, el, button } = await render({ run: linked, notes: garden });
    expect(text()).not.toContain('File it under');
    await click('Put back');
    await click('Yes');
    expect(api.revert).toHaveBeenCalledWith('r2');
    const group = el.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('File it under: Linked a note to 1 other');
    expect([...group.querySelectorAll('button')].map((b) => b.textContent!.trim())).toEqual([
      'Garden',
      'Pottery',
      'Not now',
    ]);
    expect(text()).toContain('Put back 3 notes.');
    await click('Garden');
    expect(api.reroute).toHaveBeenCalledWith('putback-r2', 'c-garden');
    expect(text()).toContain('Filed under Garden.');
    expect(el.querySelector('[role="group"]')).toBeNull();
    expect(button('Garden')).toBeUndefined();
  });

  it('goes away on Not now, without filing', async () => {
    const { api, click, el } = await render({ run: linked, notes: garden });
    await click('Put back');
    await click('Yes');
    await click('Not now');
    expect(el.querySelector('[role="group"]')).toBeNull();
    expect(api.reroute).not.toHaveBeenCalled();
  });

  it('offers the projects after a merge is put back', async () => {
    const { click, el } = await render({ notes: garden });
    await click('Put back');
    await click('Yes');
    expect(el.querySelector('[role="group"]')).not.toBeNull();
  });

  it('offers nothing after a text edit, with Projects off, or with no project', async () => {
    const edit: RunRecord = { ...linked, tool: 'add_lines', summary: 'Added 1 line to Kiln log' };
    for (const opts of [
      { run: edit, notes: garden },
      { run: linked, notes: garden, projects: false },
      { run: linked, notes: [noteRecord('k', 'Kiln log')] },
    ]) {
      TestBed.resetTestingModule();
      const { click, el, text } = await render(opts);
      await click('Put back');
      await click('Yes');
      expect(text()).toContain('Put back 3 notes.');
      expect(el.querySelector('[role="group"]')).toBeNull();
    }
  });

  it('says filing needs the network when offline, without calling', async () => {
    const { api, click, text, goOffline } = await render({ run: linked, notes: garden });
    await click('Put back');
    await click('Yes');
    goOffline();
    await click('Pottery');
    expect(text()).toContain('Filing needs the network.');
    expect(api.reroute).not.toHaveBeenCalled();
  });

  it('says why the server refused', async () => {
    const { click, text } = await render({
      run: linked,
      notes: garden,
      api: {
        reroute: vi.fn(async () => {
          throw new Error('That project is gone.');
        }),
      },
    });
    await click('Put back');
    await click('Yes');
    await click('Pottery');
    expect(text()).toContain('Could not file it: That project is gone.');
  });
});

describe('rerouteChoices (#235)', () => {
  it('lists active projects by name, never the notes filed or one under a project filed', () => {
    const all = [
      project('c-pottery', 'Pottery'),
      project('c-glazes', 'Glazes', { parent: 'c-pottery' }),
      project('c-garden', 'Garden'),
      project('c-gone', 'Gone', { archived: true }),
      project('c-old', 'Old', { projectStatus: 'done' }),
      noteRecord('k', 'Kiln log'),
    ];
    expect(rerouteChoices(all, ['k']).map((p) => p.id)).toEqual([
      'c-garden',
      'c-glazes',
      'c-pottery',
    ]);
    expect(rerouteChoices(all, ['c-pottery']).map((p) => p.id)).toEqual(['c-garden']);
  });
});
