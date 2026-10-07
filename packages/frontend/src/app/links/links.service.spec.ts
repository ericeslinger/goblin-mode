import { TestBed } from '@angular/core/testing';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { LinksService } from './links.service';

const concept = (id: string, title: string, synonyms?: string[]): NoteRecord => ({
  ...noteRecord(id, ''),
  title,
  kind: 'concept',
  ...(synonyms ? { synonyms } : {}),
});

function setup(list: NoteRecord[]) {
  const notes = new FakeNotes();
  notes.signIn(list);
  TestBed.configureTestingModule({ providers: [{ provide: NotesService, useValue: notes }] });
  return { links: TestBed.inject(LinksService), notes };
}

describe('LinksService', () => {
  it('finds backlinks from bodies, with the sentence each sits in', () => {
    const { links } = setup([
      noteRecord('n1', 'Pottery day\n- Fire it Friday. Ask [[Vik]] about the kiln. Then glaze.'),
      noteRecord('n2', 'Code note\n`[[Vikas]]` is not a link here'),
      concept('c-vikas', 'Vikas', ['Vik']),
    ]);
    expect(links.backlinksTo('c-vikas')).toEqual([
      { id: 'n1', title: 'Pottery day', sentence: 'Ask [[Vik]] about the kiln.' },
    ]);
  });

  it('follows edits, and names concepts that share notes', () => {
    const { links, notes } = setup([
      noteRecord('n1', 'Studio\n[[Kiln]] and [[Glaze]]'),
      concept('c-kiln', 'Kiln'),
      concept('c-glaze', 'Glaze'),
    ]);
    expect(links.togetherWith('c-kiln')).toEqual([{ id: 'c-glaze', title: 'Glaze' }]);
    expect(links.backlinkCounts().get('c-kiln')).toBe(1);
    notes.notes.set([noteRecord('n1', 'Studio\nonly [[Kiln]] now'), ...notes.notes().slice(1)]);
    expect(links.togetherWith('c-kiln')).toEqual([]);
    expect(links.backlinksTo('c-glaze')).toEqual([]);
  });
});
