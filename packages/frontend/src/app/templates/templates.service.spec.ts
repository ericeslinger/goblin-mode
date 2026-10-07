import { TestBed } from '@angular/core/testing';
import { NotesService } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { NEW_TEMPLATE, TemplatesService } from './templates.service';

const SHOPPING =
  'Shopping list\n## Produce\n\n## Instructions for Claude\nStart from the meal plan.';

function setup() {
  const notes = new FakeNotes();
  notes.signIn([
    { ...noteRecord('t1', SHOPPING), kind: 'template', templateMode: 'living' },
    { ...noteRecord('t2', 'Journal\nMood:'), kind: 'template' },
    { ...noteRecord('t3', 'Old'), kind: 'template', archived: true },
    noteRecord('n1', 'A note'),
  ]);
  TestBed.configureTestingModule({ providers: [{ provide: NotesService, useValue: notes }] });
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
});
