import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { RemindersService } from '../reminders/reminders.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { GroceryService } from './grocery.service';
import { MealPlanHeader } from './meal-plan-header';

const START = '2026-10-19';
const T = new Date(2026, 9, 20, 18).getTime(); // Tue Oct 20, 6 pm local

async function render(body: string, extra: NoteRecord[] = [], periodStart = START) {
  const notes = new FakeNotes();
  const plan: NoteRecord = {
    ...noteRecord('meals-2026-10-19', body),
    kind: 'mealplan',
    title: 'Meals, week of Oct 19',
    ...(periodStart ? { periodStart } : {}),
  };
  notes.signIn([plan, { ...noteRecord('r-dal', ''), kind: 'recipe', title: 'Dal' }, ...extra]);
  const reminders = { add: vi.fn() };
  const grocery = {
    listId: signal<string | undefined>('g1'),
    replan: vi.fn(() => ({ added: 2, removed: 0 })),
    makeList: vi.fn(() => 'g1'),
    made: vi.fn(() => ['onions']),
  };
  TestBed.configureTestingModule({
    imports: [MealPlanHeader],
    providers: [
      provideRouter([]),
      { provide: NotesService, useValue: notes },
      { provide: RemindersService, useValue: reminders },
      { provide: GroceryService, useValue: grocery },
      { provide: NOW, useValue: () => T },
    ],
  });
  const fixture = TestBed.createComponent(MealPlanHeader);
  fixture.componentRef.setInput('note', plan);
  fixture.componentRef.setInput('body', body);
  const edits: string[] = [];
  fixture.componentInstance.edited.subscribe((b) => {
    edits.push(b);
    fixture.componentRef.setInput('body', b);
  });
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, fixture, notes, reminders, edits, grocery };
}

const buttonNamed = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
  )!;

describe('MealPlanHeader (#129)', () => {
  const body = '## Week of Oct 19\n\n- [ ] Mon dinner:\n- [x] Tue dinner: delivery\n';

  it('draws the slots and plans a recipe that exists, refusing one that does not', async () => {
    const { el, fixture, edits, grocery } = await render(body);
    const rows = [...el.querySelectorAll('li')].map((li) => li.textContent?.replace(/\s+/g, ' '));
    expect(rows[0]).toContain('Mon dinner, Oct 19');
    expect(rows[0]).toContain('Nothing planned');
    buttonNamed(el, 'Change Mon dinner, Oct 19: nothing planned').click();
    await fixture.whenStable();
    const pick = el.querySelector<HTMLInputElement>('input[list="recipe-names"]')!;
    pick.value = 'Soup';
    buttonNamed(el, 'Plan it').click();
    await fixture.whenStable();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('No recipe is called');
    pick.value = 'dal';
    buttonNamed(el, 'Plan it').click();
    expect(edits.pop()).toContain('- [ ] Mon dinner: [[Dal]]');
    // The grocery list follows the plan (#130).
    expect(grocery.replan).toHaveBeenCalledWith(
      '2026-10-19',
      expect.objectContaining({ day: 'Mon', kind: 'empty' }),
      expect.objectContaining({ day: 'Mon', recipe: 'Dal' }),
      'Mon',
      // Tuesday is made: it needs nothing more from the shop.
      [],
    );
    await fixture.whenStable();
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'Added 2 lines to the grocery list.',
    );
  });

  it('draws the week as one row between its neighbours, today marked in words (#288)', async () => {
    const { el } = await render(body);
    const weeks = el.querySelector('nav[aria-label="Weeks"]')!;
    expect(weeks.querySelector('h2')!.textContent?.trim()).toBe('Week of Oct 19');
    expect(
      [...weeks.querySelectorAll('a')].map((a) => [
        a.getAttribute('aria-label'),
        a.getAttribute('href'),
      ]),
    ).toEqual([
      ['Previous week', '/kitchen/2026-10-12'],
      ['Next week', '/kitchen/2026-10-26'],
    ]);
    const today = [...el.querySelectorAll('ul[aria-label="Meals"] > li[aria-current="date"]')];
    expect(today).toHaveLength(1);
    expect(today[0].textContent).toContain('Tue dinner, Oct 20');
    expect(today[0].querySelector('.today-word')?.textContent?.trim()).toBe('Today');
    // The day, Today and the dinner read apart, never run together.
    expect(today[0].querySelector('.row')!.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Tue dinner, Oct 20, Today: delivery',
    );
    // The grocery list and On hand, under the week.
    expect(el.querySelector('.week-links a')?.textContent?.trim()).toBe('Grocery list');
    expect(buttonNamed(el, 'On hand')).toBeDefined();
    // Nothing the week cannot draw: no Also in this plan.
    expect(el.querySelector('section.extras')).toBeNull();
  });

  it('shows what the week cannot draw as plain words, with the way to the text', async () => {
    const typed = '## Week of Oct 19\nGuests *Friday*\n- [ ] Mon dinner:\n  - from Ma’s\n';
    const { el, fixture, edits } = await render(typed);
    const extras = el.querySelector('section.extras')!;
    expect(extras.querySelector('h3')?.textContent).toBe('Also in this plan');
    expect([...extras.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Guests Friday',
    ]);
    // The note under the dinner is in the week, not in the block.
    expect(el.querySelector('.note')?.textContent).toBe('from Ma’s');
    let asked = 0;
    fixture.componentInstance.editText.subscribe(() => asked++);
    buttonNamed(extras as HTMLElement, 'Edit as text').click();
    expect(asked).toBe(1);
    expect(edits).toEqual([]);
  });

  it('counts the lines with no words, so none is shown nowhere (2026-11-16)', async () => {
    const typed = '## Week of Oct 19\n- [ ] Mon dinner:\n![](https://example.com/a.png)\n';
    const { el } = await render(typed);
    const extras = el.querySelector('section.extras')!;
    expect(extras.querySelector('ul')).toBeNull();
    expect(extras.querySelector('.more-lines')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '1 more line without words · Edit as text',
    );
  });

  it('draws no week for a plan with no first day, every line under Also in this plan', async () => {
    const typed = '## Week of Oct 19\n- [ ] Mon dinner: [[Dal]]\n  - more lemon\n';
    const { el } = await render(typed, [], '');
    expect(el.querySelector('nav[aria-label="Weeks"]')).toBeNull();
    expect(el.querySelector('ul[aria-label="Meals"]')).toBeNull();
    const lines = [...el.querySelectorAll('section.extras li')].map((li) => li.textContent);
    expect(lines).toEqual(['Week of Oct 19', 'Mon dinner: Dal', 'more lemon']);
  });

  it('shows a slot and its notes as plain words, the text kept as typed (#285)', async () => {
    const typed = '- [ ] Mon dinner: [[Fish of the week]] (*half*)\n  - from [[Ma’s]]\n';
    const { el, edits } = await render(typed);
    const slot = buttonNamed(el, 'Change Mon dinner, Oct 19: Fish of the week (half)');
    expect(slot.textContent?.trim()).toBe('Fish of the week (half)');
    expect(el.querySelector('.note')?.textContent).toBe('from Ma’s');
    expect(el.textContent).not.toContain('[[');
    expect(edits).toEqual([]);
  });

  it('links a planned recipe to its note, with Change beside it (Eric, 2026-11-26)', async () => {
    const { el, fixture } = await render('- [ ] Mon dinner: [[Dal]] (half recipe)\n');
    const link = el.querySelector<HTMLAnchorElement>('a.recipe')!;
    expect(link.textContent).toBe('Dal (half recipe)');
    expect(link.getAttribute('href')).toBe('/n/r-dal');
    // Changing the slot is its own button now.
    const change = buttonNamed(el, 'Change Mon dinner, Oct 19: Dal (half recipe)');
    expect(change.textContent?.trim()).toBe('Change');
    change.click();
    await fixture.whenStable();
    expect(el.querySelector('input[aria-label="Recipe for Mon dinner, Oct 19"]')).not.toBeNull();
  });

  it('keeps a slot naming no recipe that exists a button, not a link', async () => {
    const { el } = await render('- [ ] Mon dinner: [[Not a recipe yet]]\n- [ ] Tue dinner: out\n');
    expect(el.querySelector('a.recipe')).toBeNull();
    expect(buttonNamed(el, 'Change Mon dinner, Oct 19: Not a recipe yet')).toBeDefined();
  });

  it('asks about a made delivery, or asks again later', async () => {
    const { el, fixture, edits, reminders } = await render(body);
    const answer = el.querySelector<HTMLInputElement>(
      'input[aria-label="What was it, and from where?"]',
    )!;
    expect(answer).not.toBeNull();
    buttonNamed(el, 'Ask me later').click();
    await fixture.whenStable();
    expect(reminders.add).toHaveBeenCalledWith({
      text: 'What was it, and from where? (Tue dinner, Oct 20)',
      dueAt: T + 60 * 60 * 1000,
      noteId: 'meals-2026-10-19',
    });
    expect(el.querySelector('input[aria-label="What was it, and from where?"]')).toBeNull();
    expect(edits).toEqual([]);
  });

  it('logs what a delivery was under its slot', async () => {
    const again = await render(body);
    const input = again.el.querySelector<HTMLInputElement>(
      'input[aria-label="What was it, and from where?"]',
    )!;
    input.value = 'dandan noodles from Ma’s';
    buttonNamed(again.el, 'Save').click();
    expect(again.edits.pop()).toContain('- [x] Tue dinner: delivery\n  - dandan noodles from Ma’s');
  });

  it('ticks a dinner made, and notes a recipe’s in its Notes too', async () => {
    const { el, fixture, edits, notes, grocery } = await render('- [ ] Mon dinner: [[Dal]]\n');
    const box = el.querySelector<HTMLInputElement>('input[aria-label="Made Mon dinner, Oct 19"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(edits.pop()).toBe('- [x] Mon dinner: [[Dal]]\n');
    // What it used is no longer on hand (#131).
    expect(grocery.made).toHaveBeenCalledWith(expect.objectContaining({ recipe: 'Dal' }));
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Used up: onions.');
    const input = el.querySelector<HTMLInputElement>('input[aria-label="How did Dal go?"]')!;
    input.value = 'Good, more lemon';
    buttonNamed(el, 'Save').click();
    expect(notes.addRecipeNote).toHaveBeenCalledWith('r-dal', '- Oct 19: Good, more lemon');
  });

  it('suggests recipes for the day, and plans one in a tap (#132)', async () => {
    const soup: NoteRecord = {
      ...noteRecord('r-soup', '## Ingredients\n\n- 2 onions\n- 1 l stock\n'),
      kind: 'recipe',
      title: 'Soup',
    };
    const pantry: NoteRecord = { ...noteRecord('pantry', '- onions\n'), kind: 'pantry' };
    const { el, fixture, edits } = await render('- [ ] Mon dinner:\n', [soup, pantry]);
    buttonNamed(el, 'Change Mon dinner, Oct 19: nothing planned').click();
    await fixture.whenStable();
    // Dal has no ingredients written yet, so only Soup is suggested.
    const ideas = el.querySelector('ul[aria-label="Suggestions for Mon dinner, Oct 19"]')!;
    expect(ideas.textContent?.replace(/\s+/g, ' ').trim()).toBe('Soup needs stock');
    buttonNamed(el, 'Plan Soup').click();
    expect(edits.pop()).toBe('- [ ] Mon dinner: [[Soup]]\n');
  });
});
