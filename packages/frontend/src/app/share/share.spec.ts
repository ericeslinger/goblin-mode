import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { CaptureService } from '../capture/capture.service';
import { type PastedImport, RECIPE_IMPORT_API } from '../kitchen/recipe-paste';
import { ModulesService } from '../modules/modules.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { ONLINE } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import { FakeAuthService, FakeModules, FakeNotes, noteRecord } from '../testing/fakes';
import { SHARE_TIMING, Share } from './share';
import { PENDING_SHARES_KEY, SHARES_TAKEN_KEY, SHARE_WORDS, type ShareWords } from './share-store';

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
    uid = 'u1',
    words = {},
    recipes = [],
  }: {
    signedIn?: boolean;
    kitchen?: boolean;
    online?: boolean;
    keep?: boolean;
    uid?: string;
    words?: Record<string, { title: string; text: string; url: string }>;
    recipes?: NoteRecord[];
  } = {},
) {
  if (keep) localStorage.clear();
  TestBed.resetTestingModule();
  const auth = new FakeAuthService();
  if (signedIn) auth.user.set({ uid, email: 'e@x.test' } as User);
  const notes = new FakeNotes();
  if (signedIn) notes.signIn(recipes);
  const stash: ShareWords = {
    read: vi.fn(async (id: string) => words[id]),
    remove: vi.fn(async () => undefined),
  };
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
      { provide: SHARE_WORDS, useValue: stash },
      { provide: SHARE_TIMING, useValue: { writeWaitMs: 200, retryMs: 10 } },
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
    stash,
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
      // As it came: read only after it is kept (review on #271).
      expect.objectContaining({
        title: 'Seeds',
        text: 'what if https://x.test/s',
        url: '',
        key: 'at:17',
        uid: 'u1',
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
    expect(kept()).toEqual([expect.objectContaining({ text: 'https://first.test' })]);
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

  it('keeps a status line in the page from the start, and says a link opens a new tab', async () => {
    const { el } = await render('/share?text=https%3A%2F%2Fx.test%2Fs&at=13');
    const status = el().querySelector('p.said[role="status"]')!;
    expect(status).toBeTruthy();
    expect(status.textContent!.trim()).toBe('');
    expect(el().querySelector('.link a')!.textContent).toContain('(opens in a new tab)');
  });

  it('never shows or files a share kept for another account (review on #271)', async () => {
    await render('/share?text=https%3A%2F%2Fx.test%2Fs&at=14');
    expect(kept()).toEqual([expect.objectContaining({ uid: 'u1' })]);
    const other = await render('/share', { keep: false, uid: 'u2' });
    expect(other.el().textContent).toContain('Nothing shared is waiting');
    expect(other.names()).toEqual([]);
    // Words alone are not filed for them either.
    seed([{ ...pending('at:15', 'what if'), uid: 'u1' }]);
    const words = await render('/share', { keep: false, uid: 'u2' });
    expect(words.notes.save).not.toHaveBeenCalled();
    expect(kept()).toHaveLength(1);
  });

  it('leaves a share another window is filing, and files it once that runs out', async () => {
    seed([{ ...pending('at:16', 'what if'), filing: { by: 'other', until: Date.now() + 60_000 } }]);
    const { notes, el } = await render('/share', { keep: false });
    expect(notes.save).not.toHaveBeenCalled();
    expect(el().textContent).toContain('being filed in another Mossgoblin window');
    expect(kept()).toHaveLength(1);

    seed([{ ...pending('at:16', 'what if'), filing: { by: 'other', until: Date.now() - 1 } }]);
    const later = await render('/share', { keep: false });
    expect(later.notes.save).toHaveBeenCalledOnce();
    expect(kept()).toEqual([]);
  });

  it('reads words sw.js stashed back from the cache, and forgets them once filed', async () => {
    const text = `${RECIPE_TEXT}\nhttps://refused.invalid/g`;
    const { button, stash, stable, el } = await render('/share?stash=55&at=55', {
      kitchen: true,
      words: { '55': { title: 'Gratin', text, url: '' } },
    });
    expect(kept()).toEqual([expect.objectContaining({ key: 'at:55', stash: '55', text: '' })]);
    await vi.waitFor(() => expect(button('Import as a recipe from this text')).toBeDefined());
    expect(el().textContent).toContain('Bake until golden.');
    button('Keep as a note')!.click();
    await stable();
    expect(stash.remove).toHaveBeenCalledWith('55');
    expect(kept()).toEqual([]);
  });

  it('files a share when the claim another window held runs out, with no reload (#271)', async () => {
    seed([{ ...pending('at:17', 'what if'), filing: { by: 'other', until: Date.now() + 150 } }]);
    const { notes, el } = await render('/share', { keep: false });
    expect(el().textContent).toContain('being filed in another Mossgoblin window');
    await vi.waitFor(() => expect(notes.save).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(kept()).toEqual([]);
  });

  it("does not take a stash that is not the share's own (review on #271)", async () => {
    const { stash } = await render('/share?stash=55&at=77&text=hello&url=https://a.example/x');
    expect(kept()).toEqual([expect.not.objectContaining({ stash: expect.anything() })]);
    expect(stash.read).not.toHaveBeenCalled();
  });

  it('says when stashed words cannot be read back', async () => {
    const { el } = await render('/share?stash=56&at=56');
    await vi.waitFor(() => expect(el().textContent).toContain('cannot be read back now'));
    expect(kept()).toHaveLength(1);
  });

  it('says how much of words the Worker cut came through, and waits for a tap', async () => {
    const { el, notes, button } = await render('/share?text=abc&at=57&cut=50000');
    expect(el().textContent).toContain('Only the first 3 of');
    expect(el().textContent).toContain('Share it again');
    expect(notes.save).not.toHaveBeenCalled();
    expect(button('Keep as a note')).toBeDefined();
  });

  it('files the share when its recipe turns out done (an answer lost, review on #271)', async () => {
    seed([{ ...pending('at:58', 'words\nhttps://refused.invalid/g'), recipeId: 'r5' }]);
    const { url } = await render('/share', {
      keep: false,
      kitchen: true,
      recipes: [{ ...noteRecord('r5', ''), kind: 'recipe', importState: 'done' }],
    });
    await vi.waitFor(() => expect(url()).toBe('/n/r5'));
    expect(kept()).toEqual([]);
  });

  it('files the share when the call fails but the server made the recipe', async () => {
    const { button, notes, importPasted, url } = await render(
      `/share?text=${encodeURIComponent(`${RECIPE_TEXT}\nhttps://refused.invalid/g`)}&at=59`,
      { kitchen: true },
    );
    importPasted.mockImplementationOnce(async (id) => {
      notes.notes.set([{ ...noteRecord(id, ''), kind: 'recipe', importState: 'done' }]);
      throw new Error('deadline-exceeded');
    });
    button('Import as a recipe from this text')!.click();
    await vi.waitFor(() => expect(url()).toMatch(/^\/n\//));
    expect(kept()).toEqual([]);
  });

  it('asks again while the server has no such recipe yet, then says so truly', async () => {
    const notThere = () =>
      Object.assign(new Error('no recipe r1'), { code: 'functions/failed-precondition' });
    const first = await render(
      `/share?text=${encodeURIComponent(`${RECIPE_TEXT}\nhttps://refused.invalid/g`)}&at=61`,
      { kitchen: true },
    );
    first.importPasted
      .mockRejectedValueOnce(notThere())
      .mockRejectedValueOnce(notThere())
      .mockResolvedValueOnce({ state: 'done' });
    first.button('Import as a recipe from this text')!.click();
    await vi.waitFor(() => expect(first.url()).toMatch(/^\/n\//));
    expect(first.importPasted).toHaveBeenCalledTimes(3);

    const again = await render(
      `/share?text=${encodeURIComponent(`${RECIPE_TEXT}\nhttps://refused.invalid/g`)}&at=62`,
      { kitchen: true },
    );
    again.importPasted.mockImplementation(async () => {
      throw notThere();
    });
    again.button('Import as a recipe from this text')!.click();
    await vi.waitFor(() =>
      expect(again.el().textContent).toContain('has not reached Mossgoblin from this device yet'),
    );
    expect(kept()).toHaveLength(1);
  });

  it('moves the recipe stub a share made to Trash when it is let go or kept as a note', async () => {
    seed([
      { ...pending('at:63', 'words\nhttps://refused.invalid/g'), recipeId: 'r6' },
      { ...pending('at:64', 'https://refused.invalid/h'), recipeId: 'r7' },
    ]);
    const { button, notes, stable } = await render('/share', { keep: false, kitchen: true });
    button('Let it go')!.click();
    await stable();
    expect(notes.dropSharedRecipe).toHaveBeenCalledWith('r7', 'https://refused.invalid/h');
    button('Keep as a note')!.click();
    await stable();
    expect(notes.dropSharedRecipe).toHaveBeenCalledWith('r6', 'https://refused.invalid/g');
    expect(kept()).toEqual([]);
  });
});

/** A share as the store keeps it. */
function pending(key: string, text: string) {
  return { key, title: '', text, url: '', at: key.slice(3), takenAt: 1 };
}

/** The store as another window, or an earlier load, left it. */
function seed(list: unknown[]): void {
  localStorage.clear();
  localStorage.setItem(PENDING_SHARES_KEY, JSON.stringify(list));
}
