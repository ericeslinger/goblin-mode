import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ProposalsService } from '../claude/proposals.service';
import { ItemsService } from '../reader/items.service';
import { ReadingService } from '../reading/reading.service';
import { RemindersService } from '../reminders/reminders.service';
import { NotesService } from '../notes/notes.service';
import { FakeModules, FakeNotes, noteRecord, FakeProposals, FakeItems } from '../testing/fakes';
import { ModulesService } from '../modules/modules.service';
import { Browse } from './browse';

describe('Browse', () => {
  it('shows the notes list with a way back', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n1', 'Groceries')]);
    await TestBed.configureTestingModule({
      imports: [Browse],
      providers: [
        provideRouter([]),
        { provide: ReadingService, useValue: { unread: signal([]) } },
        { provide: ItemsService, useValue: new FakeItems() },
        { provide: ModulesService, useValue: new FakeModules() },
        { provide: NotesService, useValue: notes },
        { provide: ProposalsService, useValue: new FakeProposals() },
        { provide: RemindersService, useValue: { reminders: signal([]) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Browse);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toBe('Notes');
    expect(el.textContent).toContain('Groceries');
    // The way back is the leaf, to Home (#219).
    expect(el.querySelector('a[aria-label="Home"]')?.getAttribute('href')).toBe('/home');
  });

  it("lists no other places: they are Home's tiles (#286)", async () => {
    const modules = new FakeModules();
    modules.set('kitchen', true);
    modules.set('reader', true);
    modules.set('podcasts', true);
    await TestBed.configureTestingModule({
      imports: [Browse],
      providers: [
        provideRouter([]),
        { provide: ReadingService, useValue: { unread: signal([]) } },
        { provide: ItemsService, useValue: new FakeItems() },
        { provide: ModulesService, useValue: modules },
        { provide: NotesService, useValue: new FakeNotes() },
        { provide: ProposalsService, useValue: new FakeProposals() },
        { provide: RemindersService, useValue: { reminders: signal([]) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Browse);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    for (const href of ['/map', '/kitchen', '/reader', '/podcasts', '/reading', '/activity']) {
      expect(el.querySelector(`a[href="${href}"]`)).toBeNull();
    }
    expect(el.querySelectorAll('h1')).toHaveLength(1);
  });

  it('offers lenses with counts, each its own URL', async () => {
    const notes = new FakeNotes();
    notes.signIn([
      noteRecord('n1', 'Groceries'),
      { ...noteRecord('c-v', ''), title: 'Vikas', kind: 'concept', conceptType: 'person' },
    ]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'browse', component: Browse },
          { path: 'browse/:lens', component: Browse },
        ]),
        { provide: ReadingService, useValue: { unread: signal([]) } },
        { provide: ItemsService, useValue: new FakeItems() },
        { provide: ModulesService, useValue: new FakeModules() },
        { provide: NotesService, useValue: notes },
        { provide: ProposalsService, useValue: new FakeProposals() },
        { provide: RemindersService, useValue: { reminders: signal([]) } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/browse/people', Browse);
    const el = harness.routeNativeElement as HTMLElement;
    const lens = (name: string) =>
      [...el.querySelectorAll('nav a')].find((a) => a.textContent?.startsWith(name))!;
    expect(lens('Recent').textContent).toContain('1');
    expect(lens('People').getAttribute('aria-current')).toBe('page');
    expect(lens('People').getAttribute('href')).toBe('/browse/people');
    expect(lens('Recent').getAttribute('href')).toBe('/browse');
    expect(el.querySelector('ul')!.textContent).toContain('Vikas');
    expect(el.querySelector('ul')!.textContent).not.toContain('Groceries');
  });

  it('counts Trash, and leaves its notes out of the other lenses (#217)', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n1', 'Groceries')]);
    notes.trash.set([{ ...noteRecord('t1', 'Kiln log'), deletedAt: Date.now() }]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'browse', component: Browse },
          { path: 'browse/:lens', component: Browse },
        ]),
        { provide: ReadingService, useValue: { unread: signal([]) } },
        { provide: ItemsService, useValue: new FakeItems() },
        { provide: ModulesService, useValue: new FakeModules() },
        { provide: NotesService, useValue: notes },
        { provide: ProposalsService, useValue: new FakeProposals() },
        { provide: RemindersService, useValue: { reminders: signal([]) } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/browse/trash', Browse);
    const el = harness.routeNativeElement as HTMLElement;
    const lens = (name: string) =>
      [...el.querySelectorAll('nav a')].find((a) => a.textContent?.startsWith(name))!;
    expect(lens('Trash').getAttribute('href')).toBe('/browse/trash');
    expect(lens('Trash').textContent).toContain('1');
    expect(lens('Recent').textContent).toContain('1');
    expect(lens('Trash').getAttribute('aria-current')).toBe('page');
    expect(el.querySelector('ul')!.textContent).toContain('Kiln log');
    expect(el.querySelector('ul')!.textContent).not.toContain('Groceries');
  });

  it('drops the Projects lens while Projects is off (#126)', async () => {
    const modules = new FakeModules();
    modules.set('projects', false);
    const notes = new FakeNotes();
    notes.signIn([
      { ...noteRecord('c-v', ''), title: 'Vikas', kind: 'concept', conceptType: 'person' },
      { ...noteRecord('c-k', ''), title: 'Kiln', kind: 'concept', conceptType: 'project' },
    ]);
    await TestBed.configureTestingModule({
      imports: [Browse],
      providers: [
        provideRouter([]),
        { provide: ReadingService, useValue: { unread: signal([]) } },
        { provide: ItemsService, useValue: new FakeItems() },
        { provide: ModulesService, useValue: modules },
        { provide: NotesService, useValue: notes },
        { provide: ProposalsService, useValue: new FakeProposals() },
        { provide: RemindersService, useValue: { reminders: signal([]) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Browse);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('People');
    expect(el.textContent).not.toContain('Projects');
    modules.set('projects', true);
    await fixture.whenStable();
    expect(el.textContent).toContain('Projects');
  });

  it('lists recipes while Kitchen is on, and starts a new one (#127)', async () => {
    const modules = new FakeModules();
    const notes = new FakeNotes();
    notes.signIn([{ ...noteRecord('r1', ''), title: 'Shakshuka', kind: 'recipe' }]);
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'browse', component: Browse },
          { path: 'browse/:lens', component: Browse },
        ]),
        { provide: ReadingService, useValue: { unread: signal([]) } },
        { provide: ItemsService, useValue: new FakeItems() },
        { provide: ModulesService, useValue: modules },
        { provide: NotesService, useValue: notes },
        { provide: ProposalsService, useValue: new FakeProposals() },
        { provide: RemindersService, useValue: { reminders: signal([]) } },
      ],
    }).compileComponents();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/browse');
    const el = harness.routeNativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Recipes');
    modules.set('kitchen', true);
    await harness.fixture.whenStable();
    expect(el.textContent).toContain('Recipes');
    await harness.navigateByUrl('/browse/recipes');
    const page = harness.routeNativeElement as HTMLElement;
    expect(page.textContent).toContain('Shakshuka');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const input = page.querySelector<HTMLInputElement>('.new-recipe input')!;
    // Not before the notes (and so the names) are here.
    notes.loaded.set(false);
    input.value = 'Dal';
    input.dispatchEvent(new Event('change'));
    await harness.fixture.whenStable();
    expect(page.querySelector('[role="status"]')?.textContent).toContain('still loading');
    expect(notes.createRecipe).not.toHaveBeenCalled();
    notes.loaded.set(true);
    input.value = 'shakshuka';
    input.dispatchEvent(new Event('change'));
    await harness.fixture.whenStable();
    expect(page.querySelector('[role="status"]')?.textContent).toContain('already names a note');
    input.value = 'Dal';
    input.dispatchEvent(new Event('change'));
    expect(notes.createRecipe).toHaveBeenLastCalledWith('Dal');
    expect(navigate).toHaveBeenCalledWith(['/n', expect.any(String)]);
    expect(input.value).toBe('');
  });

  describe('the search box and the row of lenses (#288)', () => {
    async function at(url: string, notes: FakeNotes) {
      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            { path: 'browse', component: Browse },
            { path: 'browse/:lens', component: Browse },
          ]),
          { provide: ReadingService, useValue: { unread: signal([]) } },
          { provide: ItemsService, useValue: new FakeItems() },
          { provide: ModulesService, useValue: new FakeModules() },
          { provide: NotesService, useValue: notes },
          { provide: ProposalsService, useValue: new FakeProposals() },
          { provide: RemindersService, useValue: { reminders: signal([]) } },
        ],
      });
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(url, Browse);
      // In the document, so the focus can move.
      document.body.appendChild(harness.fixture.nativeElement);
      return harness.routeNativeElement as HTMLElement;
    }
    const lensNames = (el: HTMLElement) =>
      [...el.querySelectorAll('nav[aria-label="Lenses"] a')].map((a) =>
        a.textContent?.replace(/\s+\d+$/, '').trim(),
      );

    it('puts the search box first, then the lenses, leaving out the empty ones', async () => {
      const notes = new FakeNotes();
      notes.signIn([
        noteRecord('n1', 'Groceries'),
        { ...noteRecord('n2', 'Old list'), archived: true },
      ]);
      const el = await at('/browse', notes);
      const search = el.querySelector('input[type="search"]')!;
      const nav = el.querySelector('nav[aria-label="Lenses"]')!;
      expect(search.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Archived holds a note, so it shows; Concepts, People, Trash and the rest do not.
      expect(lensNames(el)).toEqual(['Recent', 'Archived']);
    });

    it('keeps Recent and the open lens, even empty', async () => {
      const el = await at('/browse/trash', new FakeNotes());
      expect(lensNames(el)).toEqual(['Recent', 'Trash']);
      const trash = el.querySelector('nav a[aria-current="page"]')!;
      expect(trash.textContent).toContain('Trash');
      expect(el.textContent).toContain('Nothing in Trash.');
    });

    it('takes `/` to the search box, but not while typing', async () => {
      const notes = new FakeNotes();
      notes.signIn([noteRecord('n1', 'Groceries')]);
      const el = await at('/browse', notes);
      const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
      const slash = (target: EventTarget) => {
        const e = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
        target.dispatchEvent(e);
        return e.defaultPrevented;
      };
      expect(slash(document.body)).toBe(true);
      expect(document.activeElement).toBe(search);
      // In the box itself, `/` is a character.
      expect(slash(search)).toBe(false);
    });
  });
});
