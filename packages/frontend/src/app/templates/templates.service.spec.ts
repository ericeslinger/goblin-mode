import { TestBed } from '@angular/core/testing';
import { FEELINGS_TEMPLATE, templateParts } from '@mossgoblin/schema';
import { NotesService } from '../notes/notes.service';
import { RemindersService } from '../reminders/reminders.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { NEW_TEMPLATE, SHOPPING_LIST, TemplatesService } from './templates.service';

const SHOPPING =
  'Shopping list\n## Produce\n\n## Instructions for Claude\nStart from the meal plan.';

function setup(reminders: unknown = {}) {
  const notes = new FakeNotes();
  notes.signIn([
    { ...noteRecord('t1', SHOPPING), kind: 'template', templateMode: 'living' },
    { ...noteRecord('t2', 'Journal\nMood:'), kind: 'template' },
    { ...noteRecord('t3', 'Old'), kind: 'template', archived: true },
    noteRecord('n1', 'A note'),
  ]);
  TestBed.configureTestingModule({
    providers: [
      { provide: NotesService, useValue: notes },
      { provide: RemindersService, useValue: reminders },
    ],
  });
  return { notes, templates: TestBed.inject(TemplatesService) };
}

describe('TemplatesService', () => {
  it('lists live templates by name', () => {
    const { templates } = setup();
    expect(templates.templates().map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('makes a template with a section for Claude', () => {
    const { notes, templates } = setup();
    expect(templates.create('entry')).toBe('new1');
    expect(notes.create).toHaveBeenCalledWith('new1', NEW_TEMPLATE, {
      kind: 'template',
      templateMode: 'entry',
    });
  });

  it('opens a living template’s one note, making it from the skeleton the first time', () => {
    const { notes, templates } = setup();
    const made = templates.use('t1')!;
    expect(made.text).toBe('Shopping list\n## Produce');
    expect(notes.create).toHaveBeenCalledWith(made.id, made.text, { fromTemplate: 't1' });
    expect(templates.use('t1')).toEqual(made);
    expect(notes.create).toHaveBeenCalledTimes(1);
  });

  it('starts a new entry every time, and ignores what is not a template', () => {
    const { notes, templates } = setup();
    const a = templates.use('t2')!;
    const b = templates.use('t2')!;
    expect(a.id).not.toBe(b.id);
    expect(notes.create).toHaveBeenLastCalledWith(b.id, 'Journal\nMood:', { fromTemplate: 't2' });
    expect(templates.use('n1')).toBeUndefined();
  });

  it('makes the shopping list, a living template with a section for Claude', () => {
    const { notes, templates } = setup();
    expect(templates.createShoppingList()).toBe('new1');
    expect(notes.create).toHaveBeenCalledWith('new1', SHOPPING_LIST, {
      kind: 'template',
      templateMode: 'living',
    });
    const { skeleton, instructions } = templateParts(SHOPPING_LIST);
    expect(skeleton).toContain('## Produce\n\n## Butcher\n\n## Dry goods');
    expect(instructions).toContain('add_lines');
  });

  it('makes the feelings journal: an entry template and three daily reminders to it (#40)', () => {
    const reminders = { add: vi.fn() };
    const { notes, templates } = setup(reminders);
    const id = templates.createFeelingsJournal();
    expect(notes.create).toHaveBeenCalledWith(id, FEELINGS_TEMPLATE, {
      kind: 'template',
      templateMode: 'entry',
    });
    expect(reminders.add.mock.calls.map(([r]) => r)).toEqual([
      { text: 'Feelings journal: breakfast', repeat: 'daily', at: '08:00', noteId: id },
      { text: 'Feelings journal: lunch', repeat: 'daily', at: '12:30', noteId: id },
      { text: 'Feelings journal: dinner', repeat: 'daily', at: '18:30', noteId: id },
    ]);
  });
});
