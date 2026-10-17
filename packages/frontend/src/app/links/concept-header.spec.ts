import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { RemindersService, type ReminderRecord } from '../reminders/reminders.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { ConceptHeader } from './concept-header';

async function render(note: NoteRecord, others: NoteRecord[] = [], tasks: ReminderRecord[] = []) {
  const notes = new FakeNotes();
  notes.signIn([note, ...others]);
  notes.updateConcept = vi.fn(() => [] as string[]);
  const reminders = { reminders: signal(tasks), add: vi.fn(), done: vi.fn(), setItem: vi.fn() };
  TestBed.configureTestingModule({
    imports: [ConceptHeader],
    providers: [
      provideRouter([]),
      { provide: NotesService, useValue: notes },
      { provide: RemindersService, useValue: reminders },
    ],
  });
  const fixture = TestBed.createComponent(ConceptHeader);
  fixture.componentRef.setInput('note', note);
  const became = vi.fn();
  fixture.componentInstance.becameProject.subscribe(became);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  /** Unfolds the settings (2026-10-17). */
  const details = async () => {
    el.querySelector<HTMLButtonElement>('.details-toggle')!.click();
    await fixture.whenStable();
  };
  return { el, notes, reminders, became, details, fixture };
}

const project = (id: string, title: string, more: Partial<NoteRecord> = {}): NoteRecord => ({
  ...noteRecord(id, ''),
  title,
  kind: 'concept',
  conceptType: 'project',
  ...more,
});

const kiln: NoteRecord = {
  ...noteRecord('c-kiln', ''),
  title: 'Kiln',
  kind: 'concept',
  conceptType: 'project',
  synonyms: ['Oven'],
};

describe('ConceptHeader', () => {
  it('shows the name, type and other names', async () => {
    const { el, details } = await render(kiln);
    expect(el.querySelector('.synonyms')).toBeNull();
    await details();
    expect(el.querySelector<HTMLInputElement>('.name input')!.value).toBe('Kiln');
    expect(el.querySelector<HTMLSelectElement>('select')!.value).toBe('project');
    expect(el.querySelector('ul')!.textContent).toContain('Oven');
  });

  it('renames, retypes, and adds and removes other names', async () => {
    const { el, notes, details } = await render(kiln);
    await details();
    const name = el.querySelector<HTMLInputElement>('.name input')!;
    name.value = 'The kiln';
    name.dispatchEvent(new Event('change'));
    expect(notes.updateConcept).toHaveBeenLastCalledWith('c-kiln', { title: 'The kiln' });

    const type = el.querySelector<HTMLSelectElement>('select')!;
    type.value = 'person';
    type.dispatchEvent(new Event('change'));
    expect(notes.updateConcept).toHaveBeenLastCalledWith('c-kiln', { conceptType: 'person' });

    const other = el.querySelector<HTMLInputElement>('.synonyms input')!;
    other.value = 'Furnace';
    // On Enter, or on leaving the field, as a phone keyboard does.
    other.dispatchEvent(new Event('change'));
    expect(notes.updateConcept).toHaveBeenLastCalledWith('c-kiln', {
      synonyms: ['Oven', 'Furnace'],
    });
    expect(other.value).toBe('');
    expect(other.getAttribute('enterkeyhint')).toBe('done');

    el.querySelector<HTMLButtonElement>('[aria-label="Remove Oven"]')!.click();
    expect(notes.updateConcept).toHaveBeenLastCalledWith('c-kiln', { synonyms: [] });
  });

  it('puts the name back when left blank, and says when a name is taken', async () => {
    const { el, notes } = await render(kiln);
    const name = el.querySelector<HTMLInputElement>('.name input')!;
    name.value = '  ';
    name.dispatchEvent(new Event('change'));
    expect(name.value).toBe('Kiln');
    expect(notes.updateConcept).not.toHaveBeenCalled();

    notes.updateConcept.mockReturnValueOnce(['Banjo']);
    name.value = 'Banjo';
    name.dispatchEvent(new Event('change'));
    await TestBed.inject(ApplicationRef).whenStable();
    expect(name.value).toBe('Kiln');
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      '“Banjo” already names another note.',
    );
  });

  it('asks for project sections when a concept becomes a project (#41)', async () => {
    const { el, became } = await render({ ...kiln, conceptType: 'other' });
    expect(el.querySelector('.project')).toBeNull();
    const type = el.querySelector<HTMLSelectElement>('select')!;
    type.value = 'project';
    type.dispatchEvent(new Event('change'));
    expect(became).toHaveBeenCalledOnce();
  });

  it('files a project under a parent, with its kind and status (#41)', async () => {
    const sprout = project('sprout', 'Sprout', { projectKind: 'build', projectStatus: 'active' });
    const leaf = project('leaf', 'Leaf', { parent: 'sprout', projectStatus: 'waiting' });
    const twig = project('twig', 'Twig', { parent: 'leaf' });
    const studio = project('studio', 'Sprout studio');
    const { el, notes, details } = await render(sprout, [leaf, twig, studio]);
    // Folded, the kind and status are one line.
    expect(el.querySelector('.summary')!.textContent).toContain('Build · Active');
    await details();
    const [parent, kind, status] = [...el.querySelectorAll<HTMLSelectElement>('.project select')];
    // Not itself, nor anything under it.
    expect([...parent.options].map((o) => o.text)).toEqual(['None', 'Sprout studio']);
    expect(kind.value).toBe('build');
    expect(status.value).toBe('active');
    parent.value = 'studio';
    parent.dispatchEvent(new Event('change'));
    expect(notes.updateConcept).toHaveBeenLastCalledWith('sprout', { parent: 'studio' });
    parent.value = '';
    parent.dispatchEvent(new Event('change'));
    expect(notes.updateConcept).toHaveBeenLastCalledWith('sprout', { parent: null });
    status.value = 'done';
    status.dispatchEvent(new Event('change'));
    expect(notes.updateConcept).toHaveBeenLastCalledWith('sprout', { projectStatus: 'done' });
    // Its sub-projects, one level down, with kind and status.
    const children = el.querySelector('.children')!;
    expect(children.querySelector('h2')!.textContent).toBe('Projects in Sprout');
    expect(children.querySelectorAll('li').length).toBe(1);
    expect(children.textContent).toContain('Leaf');
    expect(children.textContent).toContain('Waiting');
  });

  it('shows the project’s open tasks, and adds and finishes them (#41)', async () => {
    const task = (id: string, text: string, status: ReminderRecord['status'], noteId?: string) =>
      ({ id, text, status, noteId, createdBy: 'user' }) as ReminderRecord;
    const { el, reminders } = await render(
      project('p', 'Pots'),
      [],
      [
        task('r1', 'Glaze the bowls', 'open', 'p'),
        task('r2', 'Fired', 'done', 'p'),
        task('r3', 'Elsewhere', 'open', 'q'),
      ],
    );
    const items = el.querySelectorAll('.tasks li');
    expect([...items].map((li) => li.querySelector('span')!.textContent)).toEqual([
      'Glaze the bowls',
    ]);
    el.querySelector<HTMLButtonElement>('[aria-label="Done: Glaze the bowls"]')!.click();
    expect(reminders.done).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
    const add = el.querySelector<HTMLInputElement>('.tasks input')!;
    add.value = 'Buy clay';
    add.dispatchEvent(new Event('change'));
    expect(reminders.add).toHaveBeenCalledWith({ text: 'Buy clay', noteId: 'p' });
    expect(add.value).toBe('');
  });

  it('keeps a project’s stages and item tags, in order (2026-10-17)', async () => {
    const pots = project('p', 'Pots', { stages: ['plan', 'thrown', 'bisque'], itemTags: ['gift'] });
    const { el, notes, details } = await render(pots);
    await details();
    const add = (label: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`input[placeholder="${label}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('change'));
      expect(input.value).toBe('');
    };
    add('Add a stage', 'glazed');
    expect(notes.updateConcept).toHaveBeenLastCalledWith('p', {
      stages: ['plan', 'thrown', 'bisque', 'glazed'],
    });
    el.querySelector<HTMLButtonElement>('[aria-label="Move bisque earlier"]')!.click();
    expect(notes.updateConcept).toHaveBeenLastCalledWith('p', {
      stages: ['plan', 'bisque', 'thrown'],
    });
    expect(el.querySelector('[aria-label="Move plan earlier"]')).toBeNull();
    el.querySelector<HTMLButtonElement>('[aria-label="Remove stage thrown"]')!.click();
    expect(notes.updateConcept).toHaveBeenLastCalledWith('p', { stages: ['plan', 'bisque'] });
    add('Add a tag', 'sgraffito');
    expect(notes.updateConcept).toHaveBeenLastCalledWith('p', {
      itemTags: ['gift', 'sgraffito'],
    });
    el.querySelector<HTMLButtonElement>('[aria-label="Remove tag gift"]')!.click();
    expect(notes.updateConcept).toHaveBeenLastCalledWith('p', { itemTags: [] });
  });

  it('lists items in stage order, each with a stage to pick and tags (2026-10-17)', async () => {
    const pots = project('p', 'Pots', { stages: ['plan', 'bisque'], itemTags: ['gift', 'big'] });
    const vase = project('vase', 'Vase', { parent: 'p', stage: 'bisque', tags: ['gift'] });
    const cup = project('cup', 'Cup', { parent: 'p', stage: 'plan' });
    const bowl = project('bowl', 'Bowl', { parent: 'p', stage: 'fired' });
    const jug = project('jug', 'Jug', { parent: 'p', body: '- [ ] handle\n- [x] spout' });
    const glaze = {
      id: 'r1',
      text: 'Mix glaze',
      status: 'open',
      noteId: 'p',
      stage: 'bisque',
      createdBy: 'user',
    } as ReminderRecord;
    const { el, notes, reminders, fixture } = await render(pots, [vase, cup, bowl, jug], [glaze]);
    const rows = [...el.querySelectorAll('.children .items > li')];
    expect(rows.map((li) => li.querySelector('a')!.textContent)).toEqual([
      'Cup',
      'Vase',
      'Bowl',
      'Jug',
    ]);
    expect(rows[3].textContent).toContain('1 open');
    const stage = (name: string) =>
      [...el.querySelectorAll('label')]
        .find((l) => l.textContent?.includes(`Stage of ${name}`))!
        .querySelector('select')!;
    expect(stage('Vase').value).toBe('bisque');
    // A stage the project dropped is still shown, not lost.
    expect([...stage('Bowl').options].map((o) => o.value)).toEqual(['', 'plan', 'bisque', 'fired']);
    stage('Cup').value = 'bisque';
    stage('Cup').dispatchEvent(new Event('change'));
    expect(notes.updateConcept).toHaveBeenLastCalledWith('cup', { stage: 'bisque' });
    stage('Vase').value = '';
    stage('Vase').dispatchEvent(new Event('change'));
    expect(notes.updateConcept).toHaveBeenLastCalledWith('vase', { stage: null });
    expect(stage('Mix glaze').value).toBe('bisque');
    stage('Mix glaze').value = 'plan';
    stage('Mix glaze').dispatchEvent(new Event('change'));
    expect(reminders.setItem).toHaveBeenLastCalledWith(glaze, { stage: 'plan' });

    // Tags: the ones it has show; Tag offers the rest, as toggles.
    const pressed = (name: string) => el.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
    expect(pressed('gift on Vase')!.getAttribute('aria-pressed')).toBe('true');
    expect(pressed('big on Vase')).toBeNull();
    pressed('Tag Vase')!.click();
    await fixture.whenStable();
    pressed('big on Vase')!.click();
    expect(notes.updateConcept).toHaveBeenLastCalledWith('vase', { tags: ['gift', 'big'] });
    pressed('gift on Vase')!.click();
    expect(notes.updateConcept).toHaveBeenLastCalledWith('vase', { tags: [] });
    pressed('Tag Mix glaze')!.click();
    await fixture.whenStable();
    pressed('gift on Mix glaze')!.click();
    expect(reminders.setItem).toHaveBeenLastCalledWith(glaze, { tags: ['gift'] });

    const add = el.querySelector<HTMLInputElement>('.children input')!;
    add.value = 'Teapot';
    add.dispatchEvent(new Event('change'));
    expect(notes.createItem).toHaveBeenCalledWith('p', 'Teapot');
  });
});
