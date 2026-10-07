import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { NotesService } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { Browse } from './browse';

describe('Browse', () => {
  it('shows the notes list with a way back', async () => {
    const notes = new FakeNotes();
    notes.signIn([noteRecord('n1', 'Groceries')]);
    await TestBed.configureTestingModule({
      imports: [Browse],
      providers: [provideRouter([]), { provide: NotesService, useValue: notes }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Browse);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toBe('Notes');
    expect(el.textContent).toContain('Groceries');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/');
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
        { provide: NotesService, useValue: notes },
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
});
