import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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
});
