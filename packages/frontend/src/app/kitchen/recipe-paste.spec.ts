import { TestBed } from '@angular/core/testing';
import type { NoteRecord } from '../notes/notes.service';
import { ONLINE } from '../platform/platform';
import { noteRecord } from '../testing/fakes';
import {
  MAX_PASTED_CHARS,
  type PastedImport,
  RECIPE_IMPORT_API,
  RecipePaste,
} from './recipe-paste';

const failed: NoteRecord = {
  ...noteRecord('r1', '## Ingredients\n\n## Method\n'),
  kind: 'recipe',
  title: 'Recipe from seriouseats.com',
  source: { url: 'https://www.seriouseats.com/potatoes' },
  importState: 'failed',
  importError: 'this site does not let Mossgoblin read its pages (it answered 402)',
};

async function render(note: NoteRecord, online = true) {
  const importPasted = vi.fn<(id: string, text: string) => Promise<PastedImport>>(async () => ({
    state: 'done',
  }));
  TestBed.configureTestingModule({
    imports: [RecipePaste],
    providers: [
      { provide: RECIPE_IMPORT_API, useValue: { importPasted } },
      { provide: ONLINE, useValue: () => online },
    ],
  });
  const fixture = TestBed.createComponent(RecipePaste);
  fixture.componentRef.setInput('note', note);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (name: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === name);
  const paste = async (text: string) => {
    button('Paste the page instead')!.click();
    await fixture.whenStable();
    const box = el.querySelector('textarea')!;
    box.value = text;
    box.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button('Import')!.click();
    await fixture.whenStable();
    return box;
  };
  return { el, fixture, importPasted, button, paste };
}

describe('RecipePaste (2026-11-14)', () => {
  it('is offered on a recipe whose import failed, and not otherwise', async () => {
    const { button } = await render(failed);
    expect(button('Paste the page instead')).toBeDefined();
    TestBed.resetTestingModule();
    const done = await render({ ...failed, importState: 'done' });
    expect(done.el.querySelector('button')).toBeNull();
  });

  it('labels the box and says how to fill it', async () => {
    const { el, button, fixture } = await render(failed);
    button('Paste the page instead')!.click();
    await fixture.whenStable();
    const box = el.querySelector('textarea')!;
    expect(el.querySelector(`label[for="${box.id}"]`)!.textContent).toBe('Pasted page');
    expect(el.querySelector(`#${box.getAttribute('aria-describedby')}`)!.textContent).toContain(
      'Open the recipe on seriouseats.com in your browser, select all, copy',
    );
  });

  it('sends the paste for the recipe, and clears it once imported', async () => {
    const { el, importPasted, paste } = await render(failed);
    await paste('Potatoes\nIngredients\n2 potatoes');
    expect(importPasted).toHaveBeenCalledWith('r1', 'Potatoes\nIngredients\n2 potatoes');
    expect(el.querySelector('textarea')).toBeNull();
  });

  it('keeps the paste and says why when the server found no recipe in it', async () => {
    const { el, importPasted, paste } = await render(failed);
    importPasted.mockResolvedValueOnce({ state: 'failed', error: 'no recipe found on the page' });
    const box = await paste('Terms of use');
    expect(box.value).toBe('Terms of use');
    expect(el.querySelector('.said')!.textContent).toBe(
      'Could not import it: no recipe found on the page.',
    );
  });

  it('keeps the paste when the call fails, saying it needs a connection', async () => {
    const { el, importPasted, paste } = await render(failed);
    importPasted.mockRejectedValueOnce(
      Object.assign(new Error('internal'), { code: 'functions/unavailable' }),
    );
    const box = await paste('Potatoes');
    expect(box.value).toBe('Potatoes');
    expect(el.querySelector('.said')!.textContent).toContain('this needs a connection');
  });

  it('keeps the paste offline, and does not call', async () => {
    const { el, importPasted, paste } = await render(failed, false);
    const box = await paste('Potatoes');
    expect(importPasted).not.toHaveBeenCalled();
    expect(box.value).toBe('Potatoes');
    expect(el.querySelector('.said')!.textContent).toContain('Importing needs a connection');
  });

  it('stays while its paste is read, though the recipe then says working', async () => {
    const { el, fixture, importPasted, paste } = await render(failed);
    let finish!: (r: PastedImport) => void;
    importPasted.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await paste('Potatoes');
    fixture.componentRef.setInput('note', { ...failed, importState: 'working' });
    await fixture.whenStable();
    expect(el.querySelector('textarea')!.value).toBe('Potatoes');
    finish({ state: 'done' });
    fixture.componentRef.setInput('note', { ...failed, importState: 'done' });
    await fixture.whenStable();
    expect(el.querySelector('textarea')).toBeNull();
  });

  it('refuses a paste too big to send', async () => {
    const { el, importPasted, paste } = await render(failed);
    await paste('x'.repeat(MAX_PASTED_CHARS + 1));
    expect(importPasted).not.toHaveBeenCalled();
    expect(el.querySelector('.said')!.textContent).toContain('over a million characters');
  });
});
