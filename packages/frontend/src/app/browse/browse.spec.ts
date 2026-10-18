import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { type ProposalRecord, ProposalsService } from '../claude/proposals.service';
import { ReadingService } from '../reading/reading.service';
import { NotesService } from '../notes/notes.service';
import { FakeModules, FakeNotes, noteRecord, FakeProposals } from '../testing/fakes';
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
        { provide: ModulesService, useValue: new FakeModules() },
        { provide: NotesService, useValue: notes },
        { provide: ProposalsService, useValue: new FakeProposals() },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Browse);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toBe('Notes');
    expect(el.textContent).toContain('Groceries');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/');
  });

  it('says how many suggestions wait in What Claude changed', async () => {
    const proposals = new FakeProposals();
    const open = { kind: 'link' as const, reason: 'x', notes: [], status: 'open' as const };
    proposals.list.set([
      { ...open, id: 'p1' },
      { ...open, id: 'p2' },
    ] satisfies ProposalRecord[]);
    await TestBed.configureTestingModule({
      imports: [Browse],
      providers: [
        provideRouter([]),
        { provide: ReadingService, useValue: { unread: signal([]) } },
        { provide: ModulesService, useValue: new FakeModules() },
        { provide: NotesService, useValue: new FakeNotes() },
        { provide: ProposalsService, useValue: proposals },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Browse);
    await fixture.whenStable();
    const link = (fixture.nativeElement as HTMLElement).querySelector('a[href="/activity"]')!;
    expect(link.textContent!.replace(/\s+/g, ' ').trim()).toBe('What Claude changed 2 suggestions');
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
        { provide: ModulesService, useValue: new FakeModules() },
        { provide: NotesService, useValue: notes },
        { provide: ProposalsService, useValue: new FakeProposals() },
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

  it('drops the Projects lens while Projects is off (#126)', async () => {
    const modules = new FakeModules();
    modules.set('projects', false);
    await TestBed.configureTestingModule({
      imports: [Browse],
      providers: [
        provideRouter([]),
        { provide: ReadingService, useValue: { unread: signal([]) } },
        { provide: ModulesService, useValue: modules },
        { provide: NotesService, useValue: new FakeNotes() },
        { provide: ProposalsService, useValue: new FakeProposals() },
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
        { provide: ModulesService, useValue: modules },
        { provide: NotesService, useValue: notes },
        { provide: ProposalsService, useValue: new FakeProposals() },
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
});
