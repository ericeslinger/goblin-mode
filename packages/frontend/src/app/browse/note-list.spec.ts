import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NotesService } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { matches, NoteList, snippet } from './note-list';

describe('snippet', () => {
  it('is the body after the title line, without markdown markers', () => {
    expect(snippet(noteRecord('a', '# Groceries\n- [ ] eggs\n- milk'))).toBe('eggs milk');
  });

  it('is cut with an ellipsis', () => {
    const text = snippet(noteRecord('a', `t\n${'x'.repeat(200)}`), 10);
    expect(text).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('matches', () => {
  it('needs every word, in any case, in title or body', () => {
    const note = noteRecord('a', 'Project Hotswap\ncall Vikas');
    expect(matches(note, 'vikas hotswap')).toBe(true);
    expect(matches(note, 'vikas groceries')).toBe(false);
    expect(matches(note, '  ')).toBe(true);
  });
});

describe('NoteList', () => {
  async function render(
    list = [noteRecord('n1', 'Groceries\neggs'), noteRecord('n2', 'Call Vikas')],
  ) {
    const notes = new FakeNotes();
    notes.signIn([...list, { ...noteRecord('n3', 'gone'), archived: true }, noteRecord('n4', ' ')]);
    await TestBed.configureTestingModule({
      imports: [NoteList],
      providers: [provideRouter([]), { provide: NotesService, useValue: notes }],
    }).compileComponents();
    const fixture = TestBed.createComponent(NoteList);
    fixture.componentRef.setInput('current', 'n2');
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists live, non-empty notes linking to /?note=', async () => {
    const { el } = await render();
    const links = [...el.querySelectorAll('a')];
    expect(links.map((a) => a.querySelector('.title')?.textContent)).toEqual([
      'Groceries',
      'Call Vikas',
    ]);
    expect(links[0].getAttribute('href')).toBe('/?note=n1');
    expect(links[1].getAttribute('aria-current')).toBe('true');
  });

  it('filters by search', async () => {
    const { el, fixture } = await render();
    const input = el.querySelector('input')!;
    input.value = 'vik';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(el.querySelectorAll('a').length).toBe(1);
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(el.textContent).toContain('No notes match.');
  });
});
