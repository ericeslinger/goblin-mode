import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
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

  it('lists the recipes A to Z, saying made only on one that was (#288)', () => {
    // The fish placeholder is no dish, by its id whatever its name (#220).
    setup([
      recipe('d', 'Dal', 1),
      recipe('s', 'Shakshuka', 2),
      recipe('a', 'Aloo gobi', 3),
      recipe(FISH_ID, 'Miso cod', 4),
      plan,
    ]);
    const fixture = TestBed.createComponent(KitchenRecipes);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const rows = () => [...el.querySelectorAll('ul[aria-label="Recipes"] a')];
    expect(rows().map(text)).toEqual(['Aloo gobi', 'Dal made 1×, last Oct 19', 'Shakshuka']);
    expect(rows()[1].getAttribute('href')).toBe('/n/d');
    expect(text(el.querySelector('nav a[aria-current="page"]'))).toBe('Recipes');
    // Made lately: the made one first, then the rest by name.
    const order = [...el.querySelectorAll('[role="group"][aria-label="Order"] button')];
    expect(order.map((b) => [text(b), b.getAttribute('aria-pressed')])).toEqual([
      ['A to Z', 'true'],
      ['Made lately', 'false'],
    ]);
    (order[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(rows().map(text)).toEqual(['Dal made 1×, last Oct 19', 'Aloo gobi', 'Shakshuka']);
    // The search narrows as it is typed.
    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'SHAK';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows().map(text)).toEqual(['Shakshuka']);
    search.value = 'paella';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows()).toEqual([]);
    expect(el.textContent).toContain('No recipe is called “paella”.');
  });

  it('adds a recipe as Browse does, and opens it (#288)', async () => {
    const { fake } = setup([recipe('d', 'Dal', 1)]);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(KitchenRecipes);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (name: string) =>
      [...el.querySelectorAll('button')].find((b) => text(b) === name)!;
    // The sentence that sent you to Browse is gone.
    expect(el.textContent).not.toContain('in Browse');
    expect(button('Add recipe').classList).toContain('primary');
    button('Add recipe').click();
    fixture.detectChanges();
    const name = el.querySelector<HTMLInputElement>('form input[name="name"]')!;
    // A name already taken is refused, as in Browse.
    name.value = 'Dal';
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(text(el.querySelector('[role="status"]'))).toBe('“Dal” already names a note.');
    name.value = '  Miso soup ';
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(fake.createRecipe).toHaveBeenLastCalledWith('Miso soup');
    expect(navigate).toHaveBeenCalledWith(['/n', expect.any(String)]);
    expect(el.querySelector('form')).toBeNull();
  });
});
