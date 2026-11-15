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
  return { el: fixture.nativeElement as HTMLElement, notes, fixture };
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
    expect(notes.rename).not.toHaveBeenCalled();
    name.value = 'Red lentil dal';
    name.dispatchEvent(new Event('change'));
    expect(notes.rename).toHaveBeenCalledWith('r1', 'Red lentil dal');
  });

  describe('a failed import (2026-11-15)', () => {
    const skeleton = '## Ingredients\n\n## Method\n\n## Notes\n';
    const refused: NoteRecord = {
      ...noteRecord('r1', skeleton),
      title: 'Recipe from seriouseats.com',
      kind: 'recipe',
      source: { url: 'https://www.seriouseats.com/gratin' },
      importState: 'failed',
      importError: 'this site does not let Mossgoblin read its pages (it answered 402)',
    };
    const button = (el: HTMLElement, name: string) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === name);

    it('offers Dismiss beside Try again and Paste the page instead, and dismisses', async () => {
      const { el, notes } = await render(refused);
      expect(el.querySelector('.import')!.textContent).toContain(
        'Could not import from seriouseats.com',
      );
      expect(el.querySelector('.import')!.textContent).not.toContain('What you wrote stays');
      expect(button(el, 'Try again')).toBeDefined();
      expect(button(el, 'Paste the page instead')).toBeDefined();
      button(el, 'Dismiss')!.click();
      expect(notes.dismissImport).toHaveBeenCalledWith('r1');
      // The line goes, so the keyboard's focus goes to the name.
      expect(document.activeElement).toBe(el.querySelector('input'));
    });

    it('on a recipe filled in by hand, says his text stays, and still offers all three', async () => {
      const { el } = await render({ ...refused, body });
      const line = el.querySelector('.import')!.textContent!;
      expect(line).toContain('Could not import from seriouseats.com');
      expect(line).toContain("What you wrote stays; an import puts the page's recipe on the back.");
      for (const name of ['Try again', 'Dismiss', 'Paste the page instead']) {
        expect(button(el, name)).toBeDefined();
      }
    });

    it('once dismissed, says nothing of an import and offers none', async () => {
      const { el, fixture } = await render({ ...refused, body });
      fixture.componentRef.setInput('note', {
        ...refused,
        body,
        importState: undefined,
        importError: undefined,
      });
      await fixture.whenStable();
      expect(el.querySelector('.import')).toBeNull();
      for (const name of ['Try again', 'Dismiss', 'Paste the page instead']) {
        expect(button(el, name)).toBeUndefined();
      }
    });
  });

  describe('the name as it is typed (#205)', () => {
    const dal: NoteRecord = { ...noteRecord('r1', ''), title: 'Dal', kind: 'recipe' };
    afterEach(() => vi.useRealTimers());

    async function typing() {
      const rendered = await render(dal);
      vi.useFakeTimers();
      const name = rendered.el.querySelector('input')!;
      name.focus();
      name.value = 'Red len';
      name.dispatchEvent(new Event('input'));
      return { ...rendered, name };
    }

    it('keeps every keystroke on the device at once, and writes nothing before leaving', async () => {
      const { notes, name } = await typing();
      expect(notes.holdName).toHaveBeenLastCalledWith('r1', 'Red len');
      name.value = 'Red lentil dal ';
      name.dispatchEvent(new Event('input'));
      expect(notes.holdName).toHaveBeenLastCalledWith('r1', 'Red lentil dal ');
      // No pause write: meal plan slots link by the title.
      vi.advanceTimersByTime(10_000);
      expect(notes.rename).not.toHaveBeenCalled();
      name.dispatchEvent(new Event('change'));
      expect(notes.rename).toHaveBeenCalledTimes(1);
      expect(notes.rename).toHaveBeenCalledWith('r1', 'Red lentil dal ');
    });

    it('writes at once when the page goes with the field still focused', async () => {
      const { notes } = await typing();
      window.dispatchEvent(new Event('pagehide'));
      expect(notes.rename).toHaveBeenCalledWith('r1', 'Red len');
      vi.advanceTimersByTime(10_000);
      expect(notes.rename).toHaveBeenCalledTimes(1);
    });

    it('writes at once on leaving the field, and only once', async () => {
      const { notes, name, fixture } = await typing();
      name.dispatchEvent(new Event('change'));
      expect(notes.rename).toHaveBeenCalledTimes(1);
      fixture.componentRef.setInput('note', { ...dal, title: 'Red len' });
      name.dispatchEvent(new Event('change'));
      vi.advanceTimersByTime(10_000);
      expect(notes.rename).toHaveBeenCalledTimes(1);
    });

    it('writes what waits when the header goes', async () => {
      const { notes, fixture } = await typing();
      fixture.destroy();
      expect(notes.rename).toHaveBeenCalledWith('r1', 'Red len');
    });

    it('keeps nothing for a blank name, and puts the old name back on leaving', async () => {
      const { notes, name } = await typing();
      name.value = ' ';
      name.dispatchEvent(new Event('input'));
      expect(notes.holdName).toHaveBeenLastCalledWith('r1', ' ');
      name.dispatchEvent(new Event('change'));
      expect(notes.rename).not.toHaveBeenCalled();
      expect(name.value).toBe('Dal');
    });

    it('never puts an earlier write’s snapshot over typing in the field', async () => {
      const { name, fixture } = await typing();
      name.value = 'Red lentil dal ';
      fixture.componentRef.setInput('note', { ...dal, title: 'Red len' });
      fixture.detectChanges();
      expect(name.value).toBe('Red lentil dal ');
      // Out of the field, it shows the stored name again.
      name.blur();
      fixture.componentRef.setInput('note', { ...dal, title: 'Tarka dal' });
      fixture.detectChanges();
      expect(name.value).toBe('Tarka dal');
    });
  });
});
