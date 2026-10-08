import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { launchMatcher } from '../app.routes';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { NotesService } from '../notes/notes.service';
import {
  FakeAuthService,
  FakeNotes,
  FakeRemindersApi,
  noteRecord,
  remindersTestProviders,
} from '../testing/fakes';
import { CaptureService } from '../capture/capture.service';
import { Launch } from './launch';

async function render(options: { signedIn?: boolean; notes?: FakeNotes; url?: string } = {}) {
  localStorage.clear();
  const auth = new FakeAuthService();
  if (options.signedIn ?? true) auth.user.set({ uid: 'u1', email: 'e@x.test' } as User);
  const notes = options.notes ?? new FakeNotes();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ matcher: launchMatcher, component: Launch }]),
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
      ...remindersTestProviders(new FakeRemindersApi(), () => Date.now()),
    ],
  });
  const harness = await RouterTestingHarness.create();
  // In the document before the editor renders, so autofocus can land.
  document.body.appendChild(harness.fixture.nativeElement);
  await harness.navigateByUrl(options.url ?? '/', Launch);
  const el = harness.routeNativeElement as HTMLElement;
  const fixture = { whenStable: () => harness.fixture.whenStable() };
  const go = async (url: string) => {
    await harness.navigateByUrl(url);
    await harness.fixture.whenStable();
  };
  return { fixture, el, auth, notes, go, url: () => TestBed.inject(Router).url };
}

const buttonNamed = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

/** Opens More and waits for it to show. */
async function openMore(el: HTMLElement, fixture: { whenStable(): Promise<void> }) {
  if (!el.querySelector('#more-menu')) buttonNamed(el, 'More')!.click();
  await fixture.whenStable();
}

describe('Launch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows only sign-in when signed out', async () => {
    const { el } = await render({ signedIn: false });
    expect(el.querySelector('app-sign-in')).toBeTruthy();
    expect(el.querySelector('.cm-content')).toBeNull();
  });

  it('shows the editor while the session restores on a device signed in before', async () => {
    localStorage.clear();
    const auth = new FakeAuthService();
    auth.user.set(undefined);
    auth.signedInBefore.set(true);
    await TestBed.configureTestingModule({
      imports: [Launch],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: auth },
        { provide: NotesService, useValue: new FakeNotes() },
        ...remindersTestProviders(new FakeRemindersApi(), () => Date.now()),
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Launch);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.cm-content')).toBeTruthy();
  });

  it('puts the cursor in the editor', async () => {
    const { el } = await render();
    expect(document.activeElement).toBe(el.querySelector('.cm-content[aria-label="New note"]'));
  });

  it('shows an empty Right Now', async () => {
    const { el } = await render();
    expect(el.querySelector('.right-now')?.textContent).toContain('Nothing to tend.');
  });

  it('offers previous notes and opens one at its own URL', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n1', 'Groceries\neggs'), noteRecord('n2', 'Call Vikas')]);
    const { el, fixture, url } = await render({ notes });
    buttonNamed(el, 'Previous note')!.click();
    await fixture.whenStable();
    const list = el.querySelector('[aria-label="Previous notes"]')!;
    expect(list.textContent).toContain('Groceries');
    buttonNamed(el, 'Call Vikas')!.click();
    await fixture.whenStable();
    expect(url()).toBe('/n/n2');
    expect(el.querySelector('.cm-content')?.textContent).toContain('Call Vikas');
    expect(el.querySelector('[aria-label="Previous notes"]')).toBeNull();
  });

  it('opens /n/<id>, and / goes back to the capture note', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n7', 'Linked from outside')]);
    const { el, go } = await render({ notes, url: '/n/n7' });
    expect(el.querySelector('.cm-content')?.textContent).toContain('Linked from outside');
    await go('/');
    expect(el.querySelector('.cm-content')?.textContent).not.toContain('Linked from outside');
  });

  it('sends an old /?note= link to the note’s URL', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n7', 'From a push')]);
    const { el, go, url } = await render({ notes });
    await go('/?note=n7');
    expect(url()).toBe('/n/n7');
    expect(el.querySelector('.cm-content')?.textContent).toContain('From a push');
  });

  it('holds a linked note that has not arrived, read-only, until it does', async () => {
    const notes = new FakeNotes();
    notes.signIn([]);
    const { el, fixture } = await render({ notes, url: '/n/later' });
    expect(el.textContent).toContain('This note hasn’t reached this device yet.');
    const content = el.querySelector('.cm-content')!;
    expect(content.getAttribute('contenteditable')).toBe('false');
    notes.notes.set([noteRecord('later', 'Synced at last')]);
    await fixture.whenStable();
    expect(el.textContent).not.toContain('reached this device');
    expect(content.getAttribute('contenteditable')).toBe('true');
    expect(content.textContent).toContain('Synced at last');
    expect(document.activeElement).toBe(content);
  });

  it('goes to / when coming back after five minutes starts a fresh note', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n7', 'Left open')]);
    const { fixture, url } = await render({ notes, url: '/n/n7' });
    const capture = TestBed.inject(CaptureService);
    capture.newNote();
    capture.renewed.update((n) => n + 1);
    await fixture.whenStable();
    expect(url()).toBe('/');
  });

  it('follows a tapped link to its note, making a concept for a new name', async () => {
    const notes = new FakeNotes();
    notes.signIn([
      noteRecord('n1', 'Ask [[Groceries]] and [[Kiln]]\nthe cursor sits here'),
      noteRecord('n2', 'Groceries'),
    ]);
    const { el, fixture, url } = await render({ notes, url: '/n/n1' });
    const chip = (name: string) =>
      [...el.querySelectorAll<HTMLElement>('.mg-wikilink')].find((c) => c.textContent === name)!;
    chip('Groceries').click();
    await fixture.whenStable();
    expect(url()).toBe('/n/n2');
    expect(notes.createConcept).not.toHaveBeenCalled();
    await TestBed.inject(Router).navigateByUrl('/n/n1');
    await fixture.whenStable();
    chip('Kiln').click();
    await fixture.whenStable();
    expect(notes.createConcept).toHaveBeenCalledWith('Kiln');
    expect(url()).toBe('/n/c-kiln');
  });

  it('copies a note’s link', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n7', 'Share me')]);
    const { el, fixture } = await render({ notes, url: '/n/n7' });
    await openMore(el, fixture);
    buttonNamed(el, 'Copy link')!.click();
    await fixture.whenStable();
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/n/n7`);
    expect(el.textContent).toContain('Link copied');
  });

  it('starts a new note at /', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n1', 'Old')]);
    const { el, fixture, url } = await render({ notes, url: '/n/n1' });
    buttonNamed(el, 'New')!.click();
    await fixture.whenStable();
    expect(url()).toBe('/');
    expect(el.querySelector('.cm-content')?.textContent).not.toContain('Old');
    expect(document.activeElement).toBe(el.querySelector('.cm-content'));
  });

  it('has the fresh note and its cursor ready the moment New is tapped', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n1', 'Old')]);
    const { el, fixture, url } = await render({ notes, url: '/n/n1' });
    const content = () => el.querySelector('.cm-content') as HTMLElement;
    buttonNamed(el, 'New')!.focus();
    buttonNamed(el, 'New')!.click();
    // Before any navigation settles, typing would already land in the editor.
    expect(document.activeElement).toBe(content());
    await fixture.whenStable();
    expect(url()).toBe('/');
    expect(content().textContent).not.toContain('Old');
    expect(document.activeElement).toBe(content());
  });

  it('keeps a note typed a moment before New reachable by back', async () => {
    const notes = new FakeNotes();
    notes.signIn([]);
    const { el, fixture, url } = await render({ notes });
    const capture = TestBed.inject(CaptureService);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    const old = capture.open().id;
    capture.onText('Kiln log');
    // Straight away: the 300 ms save has not run yet.
    buttonNamed(el, 'New')!.click();
    await fixture.whenStable();
    // The capture entry in history became the typed note's own URL.
    expect(navigate).toHaveBeenCalledWith(['/n', old], { replaceUrl: true });
    expect(url()).toBe('/');
    expect(capture.open().id).not.toBe(old);
  });

  it('starts a note from a template, and shows a template as one', async () => {
    const notes = new FakeNotes();
    notes.signIn([{ ...noteRecord('t1', 'Journal\nMood:'), kind: 'template' }]);
    const { el, fixture, url } = await render({ notes });
    const toggle = buttonNamed(el, 'From template')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await fixture.whenStable();
    const menu = el.querySelector('[aria-label="Templates"]')!;
    [...menu.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Journal')!.click();
    await fixture.whenStable();
    expect(notes.create).toHaveBeenCalledWith('new2', 'Journal\nMood:', { fromTemplate: 't1' });
    expect(url()).toBe('/n/new2');
    expect(el.querySelector('[aria-label="Templates"]')).toBeNull();

    await TestBed.inject(Router).navigateByUrl('/n/t1');
    await fixture.whenStable();
    const header = el.querySelector('[aria-label="Template"]')!;
    expect(header.textContent).toContain('A template.');
    const mode = header.querySelector('select')!;
    mode.value = 'living';
    mode.dispatchEvent(new Event('change'));
    expect(notes.setTemplateMode).toHaveBeenCalledWith('t1', 'living');
  });

  it('opens a new entry when a reminder links to a template (#40)', async () => {
    const notes = new FakeNotes();
    notes.signIn([
      { ...noteRecord('t1', 'Feelings\nMoods: '), kind: 'template' },
      noteRecord('n7', 'Plain note'),
    ]);
    const { el, go, url } = await render({ notes });
    await go('/n/t1?from=reminder');
    const [id, text, fields] = notes.create.mock.calls[0];
    expect([text, fields]).toEqual(['Feelings\nMoods:', { fromTemplate: 't1' }]);
    // In place of the reminder's link, so back does not make another.
    expect(url()).toBe(`/n/${id}`);
    // A reminder to a note just opens the note.
    await go('/n/n7?from=reminder');
    expect(url()).toBe('/n/n7?from=reminder');
    expect(el.querySelector('.cm-content')?.textContent).toContain('Plain note');
    expect(notes.create).toHaveBeenCalledOnce();
  });

  it('offers no template menu when there are no templates', async () => {
    const { el } = await render();
    expect(buttonNamed(el, 'From template')).toBeUndefined();
  });

  it('switches between live preview and source', async () => {
    const { el, fixture } = await render();
    const toggle = () =>
      [...el.querySelectorAll('button')].find((b) => /Source|Preview/.test(b.textContent ?? ''))!;
    await openMore(el, fixture);
    expect(toggle().textContent?.trim()).toBe('Source');
    toggle().click();
    await fixture.whenStable();
    // Choosing an item closes More, and the cursor is back in the note.
    expect(el.querySelector('#more-menu')).toBeNull();
    expect(document.activeElement).toBe(el.querySelector('.cm-content'));
    await openMore(el, fixture);
    expect(toggle().textContent?.trim()).toBe('Preview');
    toggle().click();
  });

  it('resizes Right Now from its handle, by drag or keys', async () => {
    const { el, fixture } = await render();
    const handle = el.querySelector('[role="separator"]') as HTMLElement;
    const panel = el.querySelector('.right-now') as HTMLElement;
    const key = async (k: string) => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
      await fixture.whenStable();
    };
    expect(handle.getAttribute('aria-valuenow')).toBe('35');
    expect(handle.getAttribute('aria-valuetext')).toBe('35% of the screen');
    await key('ArrowUp');
    expect(handle.getAttribute('aria-valuenow')).toBe('40');
    await key('Home');
    expect(handle.getAttribute('aria-valuenow')).toBe('80');
    await key('End');
    expect(handle.getAttribute('aria-valuenow')).toBe('15');
    await key('ArrowUp');

    const top = innerHeight * 0.8;
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientY: top + 10 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientY: innerHeight * 0.5 + 10 }));
    await fixture.whenStable();
    expect(panel.style.height).toBe('50dvh');
    handle.dispatchEvent(new PointerEvent('pointerup'));
    expect(localStorage.getItem('goblin.rightNowShare')).toBe('50');
  });

  it('shows offline when the network drops', async () => {
    const { el, fixture } = await render();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await fixture.whenStable();
    expect(el.querySelector('[role="status"].visually-hidden')?.textContent?.trim()).toBe(
      'offline',
    );
    expect(el.querySelector('.more-button .sync')?.classList).toContain('offline');
    // Not by colour alone.
    expect(el.querySelector('.more-button')?.textContent).toContain('offline');
  });

  it('keeps the rest in More, which closes on Escape and returns focus', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n7', 'Share me')]);
    const { el, fixture } = await render({ notes, url: '/n/n7' });
    const more = buttonNamed(el, 'More')!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('a[href="/settings"]')).toBeNull();
    await openMore(el, fixture);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const items = [...el.querySelectorAll('#more-menu li')].map((li) => li.textContent?.trim());
    expect(items).toEqual(['Browse', 'Source', 'Map', 'Copy link', 'History', 'Settings']);
    expect(el.querySelector('#more-menu')?.textContent).toContain('Synced');
    el.querySelector('#more-menu')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await fixture.whenStable();
    expect(el.querySelector('#more-menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    await openMore(el, fixture);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await fixture.whenStable();
    expect(el.querySelector('#more-menu')).toBeNull();
  });
});
