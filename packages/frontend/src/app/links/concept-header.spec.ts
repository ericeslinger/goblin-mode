import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { ConceptHeader } from './concept-header';

async function render(note: NoteRecord) {
  const notes = new FakeNotes();
  notes.updateConcept = vi.fn(() => [] as string[]);
  TestBed.configureTestingModule({
    imports: [ConceptHeader],
    providers: [{ provide: NotesService, useValue: notes }],
  });
  const fixture = TestBed.createComponent(ConceptHeader);
  fixture.componentRef.setInput('note', note);
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, notes };
}

const kiln: NoteRecord = {
  ...noteRecord('c-kiln', ''),
  title: 'Kiln',
  kind: 'concept',
  conceptType: 'project',
  synonyms: ['Oven'],
};

describe('ConceptHeader', () => {
  it('shows the name, type and other names', async () => {
    const { el } = await render(kiln);
    expect(el.querySelector<HTMLInputElement>('.name input')!.value).toBe('Kiln');
    expect(el.querySelector<HTMLSelectElement>('select')!.value).toBe('project');
    expect(el.querySelector('ul')!.textContent).toContain('Oven');
  });

  it('renames, retypes, and adds and removes other names', async () => {
    const { el, notes } = await render(kiln);
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
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(notes.updateConcept).toHaveBeenLastCalledWith('c-kiln', {
      synonyms: ['Oven', 'Furnace'],
    });

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
});
