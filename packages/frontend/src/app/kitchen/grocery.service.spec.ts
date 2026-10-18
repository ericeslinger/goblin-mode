import { TestBed } from '@angular/core/testing';
import { planSlots } from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { FakeModules, FakeNotes, noteRecord } from '../testing/fakes';
import { GroceryService } from './grocery.service';

const LIST = 'Shopping list\n\n## Produce\n\n- [ ] limes\n';
const SHAKSHUKA = '## Ingredients\n\n- 2 onions\n- limes\n\n## Method\n\n1. Cook.\n';

function setup(notes: NoteRecord[]) {
  const fake = new FakeNotes();
  fake.signIn(notes);
  const modules = new FakeModules();
  TestBed.configureTestingModule({
    providers: [
      { provide: NotesService, useValue: fake },
      { provide: ModulesService, useValue: modules },
    ],
  });
  return { grocery: TestBed.inject(GroceryService), notes: fake, modules };
}

const slot = (text: string) => planSlots(`- [ ] Mon dinner: ${text}`, '2026-10-19')[0];

describe('GroceryService (#130)', () => {
  const template: NoteRecord = {
    ...noteRecord('t1', 'Shopping list\n'),
    kind: 'template',
    title: 'Shopping list',
    templateMode: 'living',
  };
  const list: NoteRecord = { ...noteRecord('g1', LIST), fromTemplate: 't1' };
  const recipe: NoteRecord = { ...noteRecord('r1', SHAKSHUKA), kind: 'recipe', title: 'Shakshuka' };

  it('finds the list as the Shopping list’s living note, or the one Kitchen names', () => {
    const { grocery, modules } = setup([list, template, recipe]);
    expect(grocery.listId()).toBe('g1');
    modules.configureKitchen({ groceryList: 'r1' });
    expect(grocery.listId()).toBe('r1');
  });

  it('adds a planned dinner’s lines, skipping what is listed, and takes them off again', () => {
    const { grocery, notes, modules } = setup([list, template, recipe]);
    expect(grocery.replan(slot(''), slot('[[Shakshuka]]'), 'Mon')).toEqual({
      added: 1,
      removed: 0,
    });
    const [, body, opts] = notes.save.mock.calls[0];
    expect(body).toContain('## From recipes\n\n- [ ] 2 onions (Shakshuka, Mon)');
    expect(opts).toEqual({ base: LIST });
    // Where the list files things is remembered.
    expect(modules.configureKitchen).toHaveBeenCalledWith({ sections: { limes: 'Produce' } });

    notes.notes.set([{ ...list, body }, template, recipe]);
    expect(grocery.replan(slot('[[Shakshuka]]'), slot('delivery'), 'Mon')).toEqual({
      added: 0,
      removed: 1,
    });
  });

  it('says when there is no list to feed, and makes one: the template and its living note', () => {
    const { grocery, notes, modules } = setup([recipe]);
    expect(grocery.replan(slot(''), slot('[[Shakshuka]]'), 'Mon')).toBeUndefined();
    const id = grocery.makeList();
    const [[templateId, , templateFields], [listId, listBody, listFields]] =
      notes.create.mock.calls;
    expect(templateFields).toMatchObject({ kind: 'template', templateMode: 'living' });
    expect(listId).toBe(id);
    expect(listId).not.toBe(templateId);
    expect(listBody).toContain('## Produce');
    expect(listFields).toEqual({ fromTemplate: templateId });
    expect(modules.configureKitchen).toHaveBeenCalledWith({ groceryList: id });
  });
});
