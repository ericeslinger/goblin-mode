import { TestBed } from '@angular/core/testing';
import { FEELINGS_TEMPLATE, templateParts } from '@mossgoblin/schema';
import { signal } from '@angular/core';
import { HabitsService } from '../habits/habits.service';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { RemindersService } from '../reminders/reminders.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import {
  NEW_TEMPLATE,
  SHOPPING_LIST,
  TemplatesService,
  isFeelingsJournal,
} from './templates.service';

const SHOPPING =
  'Shopping list\n## Produce\n\n## Instructions for Claude\nStart from the meal plan.';

function setup(reminders: unknown = {}, { habitsOn = false, habits = {} as unknown } = {}) {
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
      { provide: HabitsService, useValue: habits },
      { provide: ModulesService, useValue: { habits: signal(habitsOn) } },
    ],
  });
  return { notes, templates: TestBed.inject(TemplatesService) };
}

describe('TemplatesService', () => {
  it('lists live templates by name', () => {
    const { templates } = setup();
    expect(templates.templates().map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('makes a template with its Instructions for Claude in their own field (#111)', () => {
    const { notes, templates } = setup();
    expect(templates.create('entry')).toBe('new1');
    const { skeleton, instructions } = templateParts(NEW_TEMPLATE);
    expect(notes.create).toHaveBeenCalledWith('new1', `${skeleton}\n`, {
      kind: 'template',
      templateMode: 'entry',
      instructions,
    });
    expect(instructions).toContain('How to fill in');
  });

  it('starts a note from the skeleton when the field holds the instructions (#111)', () => {
    const { notes, templates } = setup();
    notes.notes.update((list) => [
      { ...noteRecord('t4', 'Packing\n- socks'), kind: 'template', instructions: 'Ask first.' },
      ...list,
    ]);
    expect(templates.use('t4')!.text).toBe('Packing\n- socks');
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
    const { skeleton, instructions } = templateParts(SHOPPING_LIST);
    expect(notes.create).toHaveBeenCalledWith('new1', `${skeleton}\n`, {
      kind: 'template',
      templateMode: 'living',
      instructions,
    });
    expect(skeleton).toContain('## Produce\n\n## Butcher\n\n## Dry goods');
    expect(instructions).toContain('add_lines');
  });

  it('makes the feelings journal: an entry template and three daily reminders to it (#40)', () => {
    // Habits off: reminders, as before step 7 of #324.
    const reminders = { add: vi.fn() };
    const habits = { add: vi.fn() };
    const { notes, templates } = setup(reminders, { habits });
    const id = templates.createFeelingsJournal();
    const parts = templateParts(FEELINGS_TEMPLATE);
    expect(notes.create).toHaveBeenCalledWith(id, `${parts.skeleton}\n`, {
      kind: 'template',
      templateMode: 'entry',
      instructions: parts.instructions,
    });
    expect(reminders.add.mock.calls.map(([r]) => r)).toEqual([
      { text: 'Feelings journal: breakfast', repeat: 'daily', at: '08:00', noteId: id },
      { text: 'Feelings journal: lunch', repeat: 'daily', at: '12:30', noteId: id },
      { text: 'Feelings journal: dinner', repeat: 'daily', at: '18:30', noteId: id },
    ]);
    expect(habits.add).not.toHaveBeenCalled();
  });

  it('with Habits on, makes three nudged note habits on the template instead (#324 step 7)', () => {
    const reminders = { add: vi.fn() };
    const habits = { add: vi.fn((h: { name: string }) => `h-${h.name}`) };
    const { notes, templates } = setup(reminders, { habitsOn: true, habits });
    const id = templates.createFeelingsJournal();
    const parts = templateParts(FEELINGS_TEMPLATE);
    // The template exactly as before.
    expect(notes.create).toHaveBeenCalledWith(id, `${parts.skeleton}\n`, {
      kind: 'template',
      templateMode: 'entry',
      instructions: parts.instructions,
    });
    expect(habits.add.mock.calls.map(([h]) => h)).toEqual([
      {
        name: 'Feelings journal: breakfast',
        time: '08:00',
        answer: 'note',
        template: id,
        nudge: true,
      },
      { name: 'Feelings journal: lunch', time: '12:30', answer: 'note', template: id, nudge: true },
      {
        name: 'Feelings journal: dinner',
        time: '18:30',
        answer: 'note',
        template: id,
        nudge: true,
      },
    ]);
    expect(reminders.add).not.toHaveBeenCalled();
  });

  it('tells a feelings journal by its Moods line, an entry template open here', () => {
    const t = { ...noteRecord('f', 'Feelings\n\nMoods: \n'), kind: 'template' };
    expect(isFeelingsJournal(t)).toBe(true);
    expect(isFeelingsJournal({ ...t, templateMode: 'entry' })).toBe(true);
    expect(isFeelingsJournal({ ...t, templateMode: 'living' })).toBe(false);
    expect(isFeelingsJournal({ ...t, archived: true })).toBe(false);
    expect(isFeelingsJournal({ ...t, locked: true })).toBe(false);
    expect(isFeelingsJournal({ ...t, kind: 'text' })).toBe(false);
    expect(isFeelingsJournal({ ...t, body: 'Journal\nMood:' })).toBe(false);
  });
});
