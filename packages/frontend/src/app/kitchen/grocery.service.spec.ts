import { TestBed } from '@angular/core/testing';
import { planSlots } from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { NOW } from '../platform/platform';
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
      // Wednesday, Oct 21: the week of Oct 19.
      { provide: NOW, useValue: () => new Date(2026, 9, 21, 12).getTime() },
    ],
  });
  return { grocery: TestBed.inject(GroceryService), notes: fake, modules };
}

const W = '2026-10-19';
const MON = '2026-10-19/Mon/dinner';
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
    expect(grocery.replan(W, slot(''), slot('[[Shakshuka]]'), 'Mon')).toEqual({
      added: 1,
      removed: 0,
    });
    const [, body, opts] = notes.save.mock.calls[0];
    expect(body).toContain('## From recipes\n\n- [ ] 2 onions\n');
    expect(opts).toEqual({ base: LIST });
    // A list from before #207 is taken as the planned week's.
    expect(notes.setWeek).toHaveBeenCalledWith('g1', W);
    expect(notes.create).not.toHaveBeenCalled();
    // Where the list files things is remembered, and what the dinner wrote.
    expect(modules.configureKitchen).toHaveBeenCalledWith({
      sections: { limes: 'Produce' },
      wrote: { [MON]: ['- [ ] 2 onions'] },
    });

    notes.notes.set([{ ...list, body, periodStart: W }, template, recipe]);
    // Only the onions it wrote come off: Eric's limes stay (#207).
    expect(grocery.replan(W, slot('[[Shakshuka]]'), slot('delivery'), 'Mon')).toEqual({
      added: 0,
      removed: 1,
    });
    expect(notes.save.mock.calls.at(-1)![1]).toContain('- [ ] limes');
    expect(modules.config().wrote).toEqual({});
  });

  it('says when there is no list to feed, and makes one: the template and its living note', () => {
    const { grocery, notes, modules } = setup([recipe]);
    expect(grocery.replan(W, slot(''), slot('[[Shakshuka]]'), 'Mon')).toBeUndefined();
    const id = grocery.makeList();
    const [[templateId, , templateFields], [listId, listBody, listFields]] =
      notes.create.mock.calls;
    expect(templateFields).toMatchObject({ kind: 'template', templateMode: 'living' });
    expect(listId).toBe(id);
    expect(listId).not.toBe(templateId);
    expect(listBody).toContain('## Produce');
    // This week's list (#207), named for it.
    expect(listId).toBe('shopping-2026-10-19');
    expect(listFields).toEqual({
      fromTemplate: templateId,
      periodStart: '2026-10-19',
      title: 'Shopping list, week of Oct 19',
      titleSource: 'user',
    });
    expect(modules.configureKitchen).toHaveBeenCalledWith({ groceryList: id });
  });

  it('puts what was bought on hand, uses up what a made dinner needed, and skips what is here (#131)', () => {
    const pantry: NoteRecord = {
      ...noteRecord('pantry', '## Produce\n\n- salt: always\n'),
      kind: 'pantry',
      title: 'On hand',
    };
    const { grocery, notes } = setup([list, template, recipe, pantry]);
    const shopped = 'Shopping list\n\n## Produce\n\n- [x] limes\n- [ ] onions\n';
    expect(grocery.bought(shopped)).toEqual(['limes']);
    const [id, body] = notes.save.mock.calls.at(-1)!;
    expect(id).toBe('pantry');
    expect(body).toBe('## Produce\n\n- salt: always\n- limes\n');

    notes.notes.set([list, template, recipe, { ...pantry, body }]);
    // Limes are on hand: Shakshuka adds only its onions.
    expect(grocery.replan(W, slot(''), slot('[[Shakshuka]]'), 'Mon')).toMatchObject({ added: 1 });
    expect(grocery.made(slot('[[Shakshuka]]'))).toEqual(['limes']);
    expect(notes.save.mock.calls.at(-1)![1]).toBe('## Produce\n\n- salt: always\n');
  });

  it('starts a new week’s list on the first dinner planned into a newer week (#207)', () => {
    const old: NoteRecord = {
      ...list,
      body: 'Shopping list\n\n## Produce\n\n- [ ] limes\n\n## Dry goods\n\n- [x] rice ★\n',
      periodStart: W,
    };
    const { grocery, notes, modules } = setup([old, template, recipe]);
    modules.configureKitchen({ wrote: { '2026-10-12/Mon/dinner': ['- [ ] rice'] } });
    // Clearing a newer week's slot, or planning the list's own week or
    // an older one: the list stays.
    grocery.replan('2026-10-26', slot('[[Shakshuka]]'), slot(''), 'Mon');
    grocery.replan('2026-10-12', slot(''), slot('[[Shakshuka]]'), 'Mon');
    expect(notes.create).not.toHaveBeenCalled();
    expect(notes.setArchived).not.toHaveBeenCalled();

    expect(grocery.replan('2026-10-26', slot(''), slot('[[Shakshuka]]'), 'Mon')).toEqual({
      added: 2,
      removed: 0,
    });
    const [id, body, fields] = notes.create.mock.calls[0];
    expect(id).toBe('shopping-2026-10-26');
    // The template's text, the staple unticked, and the dinner's lines,
    // limes under Produce where the old list filed them; the old list's
    // own limes stay behind with it.
    expect(body).toBe(
      'Shopping list\n\n## Dry goods\n\n- [ ] rice ★\n\n## From recipes\n\n- [ ] 2 onions\n\n## Produce\n\n- [ ] limes\n',
    );
    expect(fields).toEqual({
      fromTemplate: 't1',
      periodStart: '2026-10-26',
      title: 'Shopping list, week of Oct 26',
      titleSource: 'user',
    });
    expect(notes.setArchived).toHaveBeenCalledWith('g1', true);
    // Kitchen names the new list, and forgets what older weeks wrote.
    expect(modules.config()).toMatchObject({
      groceryList: id,
      wrote: { '2026-10-26/Mon/dinner': ['- [ ] 2 onions', '- [ ] limes'] },
    });
  });

  it('leaves things be with no list, and says which dinners want an item', () => {
    const { grocery, notes } = setup([template, recipe]);
    expect(grocery.replan(W, slot(''), slot('[[Shakshuka]]'), 'Mon')).toBeUndefined();
    expect(notes.create).not.toHaveBeenCalled();

    const plan: NoteRecord = {
      ...noteRecord(
        'meals-2026-10-19',
        '- [ ] Mon dinner: [[Shakshuka]]\n- [x] Tue dinner: [[Shakshuka]]\n',
      ),
      kind: 'mealplan',
      periodStart: '2026-10-19',
    };
    notes.notes.set([list, template, recipe, plan]);
    expect(grocery.isList(list)).toBe(true);
    expect(grocery.isList(recipe)).toBe(false);
    // A list from before #207 reads as this week's; a made dinner needs nothing.
    expect(grocery.sources({ ...list, body: '- [ ] 2 onions\n- [ ] limes\n' })).toEqual({
      start: '2026-10-19',
      items: [
        { item: '2 onions', dinners: ['Shakshuka (Mon)'] },
        { item: 'limes', dinners: ['Shakshuka (Mon)'] },
      ],
    });
  });
});
