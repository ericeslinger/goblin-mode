import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NotesService, type NoteRecord } from '../notes/notes.service';
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

  it('lists live, non-empty notes linking to /n/<id>', async () => {
    const { el } = await render();
    const links = [...el.querySelectorAll('a')];
    expect(links.map((a) => a.querySelector('.title')?.textContent)).toEqual([
      'Groceries',
      'Call Vikas',
    ]);
    expect(links[0].getAttribute('href')).toBe('/n/n1');
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

  it('lists a lens: concepts say how many notes link to them, tags are grouped', async () => {
    const { el, fixture } = await render([
      noteRecord('n1', 'Studio\nwith [[Kiln]]'),
      { ...noteRecord('c-kiln', ''), title: 'Kiln', kind: 'concept', conceptType: 'project' },
      { ...noteRecord('t1', 'Calm day'), tags: ['feelings', 'date night'] },
    ]);
    fixture.componentRef.setInput('lens', 'projects');
    await fixture.whenStable();
    expect(el.querySelector('ul')!.textContent).toContain('Kiln');
    expect(el.querySelector('ul')!.textContent).toContain('Linked from 1 note');

    fixture.componentRef.setInput('lens', 'tags');
    await fixture.whenStable();
    const headings = [...el.querySelectorAll('h2')];
    expect(headings.map((h) => h.textContent)).toEqual(['#date night (1)', '#feelings (1)']);
    // Each group is named by its heading, even for a tag with a space.
    for (const list of el.querySelectorAll('ul[aria-labelledby]')) {
      const label = el.querySelector(`#${list.getAttribute('aria-labelledby')}`);
      expect(label?.tagName).toBe('H2');
    }
    expect(el.querySelector('ul')!.textContent).toContain('Calm day');

    fixture.componentRef.setInput('lens', 'archived');
    await fixture.whenStable();
    expect(el.querySelector('ul')!.textContent).toContain('gone');
  });

  it('lists projects as a tree with kind and status, filtered by status (#41)', async () => {
    const project = (id: string, title: string, more: Partial<NoteRecord> = {}): NoteRecord => ({
      ...noteRecord(id, ''),
      title,
      kind: 'concept',
      conceptType: 'project',
      ...more,
    });
    const { el, fixture } = await render([
      project('sprout', 'Sprout', { projectKind: 'build', projectStatus: 'active' }),
      project('leaf', 'Leaf', { parent: 'sprout', projectStatus: 'waiting' }),
    ]);
    fixture.componentRef.setInput('lens', 'projects');
    await fixture.whenStable();
    const rows = [...el.querySelectorAll<HTMLLIElement>('ul[aria-label="Projects"] li')];
    expect(rows.map((r) => r.querySelector('.title')!.textContent)).toEqual(['Sprout', 'Leaf']);
    expect(rows[0].textContent).toContain('Build · Active');
    expect(rows[1].style.paddingLeft).toBe('20px');
    const status = el.querySelector<HTMLSelectElement>('.status select')!;
    status.value = 'waiting';
    status.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    // Its parent filtered out, Leaf stands at the top.
    const left = [...el.querySelectorAll<HTMLLIElement>('ul[aria-label="Projects"] li')];
    expect(left.map((r) => r.querySelector('.title')!.textContent)).toEqual(['Leaf']);
    expect(left[0].style.paddingLeft).toBe('0px');
  });

  it('lists journal entries with their moods (#40)', async () => {
    const { el, fixture } = await render([
      { ...noteRecord('e1', 'Feelings\nMoods: [[calm]], tired\n\nslow day'), createdAt: 1 },
      noteRecord('n1', 'Just a note'),
    ]);
    fixture.componentRef.setInput('lens', 'journal');
    await fixture.whenStable();
    const rows = el.querySelectorAll('ul li');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.snippet')!.textContent).toContain('calm, tired');
  });
});
