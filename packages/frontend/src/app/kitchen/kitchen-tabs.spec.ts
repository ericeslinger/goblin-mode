import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { FISH_ID } from '@mossgoblin/schema';
import { FakeModules, FakeNotes, noteRecord } from '../testing/fakes';
import { GroceryService } from './grocery.service';
import { KitchenRecipes } from './kitchen-recipes';
import { KitchenShopping } from './kitchen-shopping';

const LIST = 'Shopping list\n\n## Produce\n- [ ] limes\n- [x] onions\n\n## Dry goods\n- [ ] rice';

function setup(notes: NoteRecord[], listId?: string) {
  const fake = new FakeNotes();
  fake.signIn(notes);
  const modules = new FakeModules();
  modules.set('kitchen', true);
  const grocery = {
    listId: signal(listId),
    makeList: vi.fn(() => 'made'),
    remember: vi.fn(),
    bought: vi.fn(() => []),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: NotesService, useValue: fake },
      { provide: ModulesService, useValue: modules },
      { provide: GroceryService, useValue: grocery },
    ],
  });
  return { fake, grocery };
}

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('Kitchen tabs (#220)', () => {
  it('shops from the grocery list in List view, with what is left to buy on its tab', () => {
    const { fake, grocery } = setup(
      [{ ...noteRecord('list', LIST), title: 'Week of Nov 9' }],
      'list',
    );
    const fixture = TestBed.createComponent(KitchenShopping);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const tabs = el.querySelector('nav[aria-label="Kitchen screens"]')!;
    const current = tabs.querySelector('a[aria-current="page"]');
    expect(text(current)).toBe('Shopping 2 to buy');
    expect(current!.getAttribute('href')).toBe('/kitchen/shopping');
    expect([...tabs.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/kitchen',
      '/kitchen/shopping',
      '/kitchen/recipes',
      '/kitchen/pantry',
    ]);
    expect(el.querySelector('h1')!.textContent).toBe('Kitchen');
    expect(el.querySelector('a[aria-label="Home"]')).not.toBeNull();
    // A tick is the note's own write, over the text it was made from.
    el.querySelector<HTMLInputElement>('section[aria-label="List"] input[type=checkbox]')!.click();
    expect(fake.save).toHaveBeenCalledWith('list', expect.stringContaining('- [x] limes'), {
      base: LIST,
      keep: false,
    });
    expect(grocery.bought).not.toHaveBeenCalled();
  });

  it('offers to make the grocery list while there is none', () => {
    const { grocery } = setup([]);
    const fixture = TestBed.createComponent(KitchenShopping);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(text(el.querySelector('nav a[aria-current]'))).toBe('Shopping');
    const make = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Make the grocery list',
    )!;
    make.click();
    expect(grocery.makeList).toHaveBeenCalled();
  });

  it('lists the recipes newest first, each with how often it was made', () => {
    const recipe = (id: string, title: string, createdAt: number): NoteRecord => ({
      ...noteRecord(id, `${title}\n\n## Ingredients\n\n## Method\n\n## Notes`),
      kind: 'recipe',
      title,
      createdAt,
    });
    const plan: NoteRecord = {
      ...noteRecord('meals-2026-10-19', 'Meals, week of Oct 19\n\n- [x] Mon dinner: [[Dal]]'),
      kind: 'mealplan',
      periodStart: '2026-10-19',
    };
    // The fish placeholder is no dish, by its id whatever its name (#220).
    setup([
      recipe('d', 'Dal', 1),
      recipe('s', 'Shakshuka', 2),
      recipe(FISH_ID, 'Miso cod', 3),
      plan,
    ]);
    const fixture = TestBed.createComponent(KitchenRecipes);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('ul[aria-label="Recipes"] a')];
    expect(rows.map(text)).toEqual(['Shakshuka Not made yet', 'Dal Made once, last Oct 19']);
    expect(rows[1].getAttribute('href')).toBe('/n/d');
    expect(text(el.querySelector('nav a[aria-current="page"]'))).toBe('Recipes');
  });
});
