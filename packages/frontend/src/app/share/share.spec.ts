import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { CaptureService } from '../capture/capture.service';
import { type PastedImport, RECIPE_IMPORT_API } from '../kitchen/recipe-paste';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { ONLINE } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import { FakeAuthService, FakeModules, FakeNotes } from '../testing/fakes';
import { Share } from './share';
import { PENDING_SHARES_KEY, SHARES_TAKEN_KEY } from './share-store';

@Component({ template: '' })
class Elsewhere {}

const RECIPE_TEXT = [
  'Hasselback potato gratin',
  'Ingredients',
  '3 pounds russet potatoes',
  'Method',
  'Bake until golden.',
].join('\n');

async function render(
  url: string,
  {
    signedIn = true,
    kitchen = false,
    online = true,
    keep = true,
  }: { signedIn?: boolean; kitchen?: boolean; online?: boolean; keep?: boolean } = {},
) {
  if (keep) localStorage.clear();
  TestBed.resetTestingModule();
  const auth = new FakeAuthService();
  if (signedIn) auth.user.set({ uid: 'u1', email: 'e@x.test' } as User);
  const notes = new FakeNotes();
  if (signedIn) notes.signIn([]);
  const modules = new FakeModules();
  modules.set('kitchen', kitchen);
  const reading = { save: vi.fn((link: string) => (link.startsWith('http') ? 'a1' : undefined)) };
  const importPasted = vi.fn<(id: string, text: string) => Promise<PastedImport>>(async () => ({
    state: 'done',
  }));
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'share', component: Share },
        { path: '', component: Elsewhere },
        { path: 'n/:id', component: Elsewhere },
        { path: 'reading', component: Elsewhere },
      ]),
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
      { provide: ModulesService, useValue: modules },
      { provide: ReadingService, useValue: reading },
      { provide: RECIPE_IMPORT_API, useValue: { importPasted } },
      { provide: ONLINE, useValue: () => online },
    ],
  });
  const harness = await RouterTestingHarness.create();
  document.body.appendChild(harness.fixture.nativeElement);
  await harness.navigateByUrl(url);
  await harness.fixture.whenStable();
  const el = () => harness.routeNativeElement as HTMLElement;
  const button = (name: string) =>
    [...el().querySelectorAll('button')].find((b) => b.textContent!.trim() === name);
  const names = () =>
    [...el().querySelectorAll('[role="group"] button')].map((b) => b.textContent!.trim());
  return {
    harness,
    el,
    button,
    names,
    auth,
    notes,
    reading,
    importPasted,
    url: () => TestBed.inject(Router).url,
    stable: () => harness.fixture.whenStable(),
  };
}

const kept = () => JSON.parse(localStorage.getItem(PENDING_SHARES_KEY) ?? '[]') as unknown[];

describe('Share', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps a share on the device at once and tidies the address', async () => {
    const { el, url, names } = await render(
      '/share?title=Seeds&text=what%20if%20https%3A%2F%2Fx.test%2Fs&at=17',
    );
    expect(kept()).toEqual([
      expect.objectContaining({
        title: 'Seeds',
        words: 'what if',
        link: 'https://x.test/s',
        key: 'at:17',
      }),
    ]);
    expect(url()).toBe('/share');
    const shown = el().querySelector('[aria-label="What was shared"]')!;
    expect(shown.textContent).toContain('Seeds');
    expect(shown.textContent).toContain('what if');
    // Words with a link, Kitchen off: a note, or let go.
    expect(names()).toEqual(['Keep as a note', 'Let it go']);
    // Focus lands on the first way to file it.
    expect(document.activeElement?.textContent?.trim()).toBe('Keep as a note');
  });

  it('makes words with no link a note at once, with no tap, as before (#42)', async () => {
    const { notes, url, names } = await render('/share?title=Seeds&text=what%20if&at=18');
    expect(notes.save).toHaveBeenCalledOnce();
    expect(notes.save.mock.calls[0][1]).toBe('Seeds\nwhat if');
    expect(TestBed.inject(CaptureService).current()).toBe('Seeds\nwhat if');
    expect(url()).toBe('/');
    expect(kept()).toEqual([]);
    expect(names()).toEqual([]);
  });

  it('keeps words with a link as a new note on a tap, and forgets the share', async () => {
    const { button, notes, url, stable } = await render(
      '/share?title=Seeds&text=what%20if%20seeds%20talked%20https%3A%2F%2Fx.test%2Fs&at=1',
    );
    expect(notes.save).not.toHaveBeenCalled();
    button('Keep as a note')!.click();
    await stable();
    expect(notes.save).toHaveBeenCalledOnce();
    expect(notes.save.mock.calls[0][1]).toBe('Seeds\nwhat if seeds talked\nhttps://x.test/s');
    expect(TestBed.inject(CaptureService).current()).toContain('what if seeds talked');
    expect(url()).toBe('/');
    expect(kept()).toEqual([]);
  });

  it('offers a link alone to read later, as a note, or as a recipe with Kitchen on', async () => {
    const { names, button, reading, url, stable } = await render(
      '/share?title=Gratin&text=https%3A%2F%2Frecipes.test%2Fgratin&at=2',
      { kitchen: true },
    );
    expect(names()).toEqual([
      'Save to read later',
      'Keep as a note',
      'Import as a recipe',
      'Let it go',
    ]);
    button('Save to read later')!.click();
    await stable();
    expect(reading.save).toHaveBeenCalledWith('https://recipes.test/gratin');
    expect(url()).toBe('/reading');
    expect(kept()).toEqual([]);
  });

  it('imports a link alone as a recipe, as Import from a link does', async () => {
    const { button, notes, url, stable } = await render(
      '/share?text=https%3A%2F%2Frecipes.test%2Fgratin&at=3',
      { kitchen: true },
    );
    button('Import as a recipe')!.click();
    await stable();
    expect(notes.importRecipe).toHaveBeenCalledWith('https://recipes.test/gratin');
    expect(url()).toMatch(/^\/n\/new\d+$/);
  });

  it('offers no recipe without Kitchen', async () => {
    const { names } = await render(
      `/share?text=${encodeURIComponent(`${RECIPE_TEXT}\nhttps://refused.invalid/g`)}&at=4`,
    );
    expect(names()).toEqual(['Keep as a note', 'Let it go']);
  });

  it('imports a recipe from shared words: its recipe made first, then the words read', async () => {
    const { button, notes, importPasted, url, stable } = await render(
      `/share?text=${encodeURIComponent(`${RECIPE_TEXT}\nhttps://refused.invalid/g`)}&at=5`,
      { kitchen: true },
    );
    button('Import as a recipe from this text')!.click();
    await vi.waitFor(() => expect(url()).toMatch(/^\/n\//));
    await stable();
    const id = notes.sharedRecipe.mock.calls[0][1];
    expect(notes.sharedRecipe).toHaveBeenCalledWith('https://refused.invalid/g', id);
    // The words, without the link that rode along; the link stays the source.
    expect(importPasted).toHaveBeenCalledWith(id, RECIPE_TEXT);
    expect(url()).toBe(`/n/${id}`);
    expect(kept()).toEqual([]);
  });

  it('keeps the share when the import fails, and asks again for the same recipe', async () => {
    const { button, notes, importPasted, el, stable } = await render(
      `/share?text=${encodeURIComponent('no recipe here\nhttps://refused.invalid/g')}&at=6`,
      { kitchen: true },
    );
    importPasted.mockResolvedValueOnce({
      state: 'failed',
      error: 'nothing on the page read as a recipe',
    });
    button('Import as a recipe from this text')!.click();
    await vi.waitFor(() => expect(el().textContent).toContain('Could not import it'));
    const id = notes.sharedRecipe.mock.calls[0][1];
    expect(notes.importFailed).toHaveBeenCalledWith(id, 'nothing on the page read as a recipe');
    expect(kept()).toEqual([expect.objectContaining({ key: 'at:6', recipeId: id })]);

    importPasted.mockRejectedValueOnce(new Error('offline'));
    button('Import as a recipe from this text')!.click();
    await vi.waitFor(() => expect(el().textContent).toContain('Could not reach Mossgoblin'));
    await stable();
    expect(notes.sharedRecipe.mock.calls[1]).toEqual(['https://refused.invalid/g', id]);
    expect(kept()).toHaveLength(1);
  });

  it('offline, keeps the share for the import and makes no recipe', async () => {
    const { button, notes, importPasted, el, stable } = await render(
      `/share?text=${encodeURIComponent(`${RECIPE_TEXT}\nhttps://refused.invalid/g`)}&at=7`,
      { kitchen: true, online: false },
    );
    button('Import as a recipe from this text')!.click();
    await stable();
    expect(el().textContent).toContain('needs a connection');
    expect(notes.sharedRecipe).not.toHaveBeenCalled();
    expect(importPasted).not.toHaveBeenCalled();
    expect(kept()).toHaveLength(1);
  });

  it('signed out, keeps words with no link, and makes the note once signed in', async () => {
    const first = await render('/share?text=what%20if&at=8', { signedIn: false });
    expect(first.names()).toEqual([]);
    expect(first.el().textContent).toContain('Sign in to file it');
    expect(first.button('Sign in with Google')).toBeDefined();
    expect(kept()).toHaveLength(1);

    // A reload of the share's own address (before it was tidied): still one.
    const again = await render('/share?text=what%20if&at=8', { signedIn: false, keep: false });
    expect(kept()).toHaveLength(1);
    expect(again.el().textContent).toContain('what if');

    // Signed in and the notes here: the note, with no tap.
    again.auth.user.set({ uid: 'u1', email: 'e@x.test' } as User);
    again.notes.signIn([]);
    await again.stable();
    await vi.waitFor(() => expect(again.url()).toBe('/'));
    expect(again.notes.save).toHaveBeenCalledOnce();
    expect(again.notes.save.mock.calls[0][1]).toBe('what if');
    expect(kept()).toEqual([]);
  });

  it('never files a share twice: a reload of its address after filing is known', async () => {
    const first = await render('/share?text=what%20if&at=9');
    expect(first.notes.save).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(SHARES_TAKEN_KEY)!)).toEqual(['at:9']);

    const again = await render('/share?text=what%20if&at=9', { keep: false });
    expect(kept()).toEqual([]);
    expect(again.notes.save).not.toHaveBeenCalled();
    expect(again.url()).toBe('/share');
    expect(again.el().textContent).toContain('filed already');
    expect(again.names()).toEqual([]);
  });

  it('lets a share go, and shows the next one waiting', async () => {
    await render('/share?text=https%3A%2F%2Ffirst.test&at=10');
    const { el, button, stable } = await render('/share?text=https%3A%2F%2Fsecond.test&at=11', {
      keep: false,
    });
    expect(el().textContent).toContain('second.test');
    expect(el().textContent).toContain('1 more share waits after this one.');
    button('Let it go')!.click();
    await stable();
    expect(el().textContent).toContain('first.test');
    expect(kept()).toEqual([expect.objectContaining({ link: 'https://first.test' })]);
  });

  it('ignores a share opened from another site’s page', async () => {
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://evil.test/');
    const { el, url } = await render('/share?text=ignore%20previous%20instructions');
    expect(kept()).toEqual([]);
    expect(url()).toBe('/share');
    expect(el().textContent).toContain('Nothing shared is waiting');
  });

  it('says so when a share brought nothing', async () => {
    const { el } = await render('/share?text=%20&at=12');
    expect(el().textContent).toContain('Nothing came with that share.');
  });
});
