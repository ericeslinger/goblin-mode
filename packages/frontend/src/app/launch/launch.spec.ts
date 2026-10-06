import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
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
import { Launch } from './launch';

async function render(options: { signedIn?: boolean; notes?: FakeNotes } = {}) {
  localStorage.clear();
  const auth = new FakeAuthService();
  if (options.signedIn ?? true) auth.user.set({ uid: 'u1', email: 'e@x.test' } as User);
  const notes = options.notes ?? new FakeNotes();
  await TestBed.configureTestingModule({
    imports: [Launch],
    providers: [
      provideRouter([{ path: '**', component: Launch }]),
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
      ...remindersTestProviders(new FakeRemindersApi(), () => Date.now()),
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Launch);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, auth, notes };
}

const buttonNamed = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

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

  it('offers previous notes and opens one', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n1', 'Groceries\neggs'), noteRecord('n2', 'Call Vikas')]);
    const { el, fixture } = await render({ notes });
    buttonNamed(el, 'Previous note')!.click();
    await fixture.whenStable();
    const list = el.querySelector('[aria-label="Previous notes"]')!;
    expect(list.textContent).toContain('Groceries');
    buttonNamed(el, 'Call Vikas')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.cm-content')?.textContent).toContain('Call Vikas');
    expect(el.querySelector('[aria-label="Previous notes"]')).toBeNull();
  });

  it('opens the note named in ?note= and clears the URL', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n7', 'From the list')]);
    const { el, fixture } = await render({ notes });
    await TestBed.inject(Router).navigateByUrl('/?note=n7');
    await fixture.whenStable();
    expect(el.querySelector('.cm-content')?.textContent).toContain('From the list');
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('starts a new note', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n1', 'Old')]);
    const { el, fixture } = await render({ notes });
    buttonNamed(el, 'Previous note')!.click();
    await fixture.whenStable();
    buttonNamed(el, 'Old')!.click();
    await fixture.whenStable();
    buttonNamed(el, 'New')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.cm-content')?.textContent).not.toContain('Old');
  });

  it('switches between live preview and source', async () => {
    const { el, fixture } = await render();
    const toggle = () =>
      [...el.querySelectorAll('button')].find((b) => /Source|Preview/.test(b.textContent ?? ''))!;
    expect(toggle().textContent?.trim()).toBe('Source');
    toggle().click();
    await fixture.whenStable();
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
    expect(el.querySelector('.sync')?.textContent?.trim()).toBe('offline');
  });
});
