import { TestBed } from '@angular/core/testing';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { RecipeHeader } from './recipe-header';

async function render(note: NoteRecord) {
  const notes = new FakeNotes();
  notes.signIn([note]);
  TestBed.configureTestingModule({
    imports: [RecipeHeader],
    providers: [{ provide: NotesService, useValue: notes }],
  });
  const fixture = TestBed.createComponent(RecipeHeader);
  fixture.componentRef.setInput('note', note);
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, notes };
}

describe('RecipeHeader (#127)', () => {
  const body = '## Ingredients\n\n- 2 onions\n- 400 g tomatoes\n\n## Method\n\n1. Cook.\n';

  it('names the recipe and says what its text holds', async () => {
    const { el } = await render({
      ...noteRecord('r1', body),
      title: 'Shakshuka',
      kind: 'recipe',
      servings: 2,
    });
    expect(el.querySelector('input')!.value).toBe('Shakshuka');
    expect(el.querySelector('.meta')!.textContent).toBe(
      'Recipe · serves 2 · 2 ingredients · 1 step',
    );
  });

  it('renames it, and puts a blank name back', async () => {
    const { el, notes } = await render({ ...noteRecord('r1', ''), title: 'Dal', kind: 'recipe' });
    const name = el.querySelector('input')!;
    name.value = '  ';
    name.dispatchEvent(new Event('change'));
    expect(name.value).toBe('Dal');
    expect(notes.updateRecipe).not.toHaveBeenCalled();
    name.value = 'Red lentil dal';
    name.dispatchEvent(new Event('change'));
    expect(notes.updateRecipe).toHaveBeenCalledWith('r1', { title: 'Red lentil dal' });
  });
});
