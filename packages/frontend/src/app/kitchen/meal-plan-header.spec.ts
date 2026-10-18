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

async function render(body: string) {
  const notes = new FakeNotes();
  const plan: NoteRecord = {
    ...noteRecord('meals-2026-10-19', body),
    kind: 'mealplan',
    title: 'Meals, week of Oct 19',
    periodStart: START,
  };
  notes.signIn([plan, { ...noteRecord('r-dal', ''), kind: 'recipe', title: 'Dal' }]);
  const reminders = { add: vi.fn() };
  const grocery = {
    listId: signal<string | undefined>('g1'),
    replan: vi.fn(() => ({ added: 2, removed: 0 })),
    makeList: vi.fn(() => 'g1'),
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
      expect.objectContaining({ day: 'Mon', kind: 'empty' }),
      expect.objectContaining({ day: 'Mon', recipe: 'Dal' }),
      'Mon',
    );
    await fixture.whenStable();
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'Added 2 lines to the grocery list.',
    );
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
    const { el, fixture, edits, notes } = await render('- [ ] Mon dinner: [[Dal]]\n');
    const box = el.querySelector<HTMLInputElement>('input[aria-label="Made Mon dinner, Oct 19"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(edits.pop()).toBe('- [x] Mon dinner: [[Dal]]\n');
    const input = el.querySelector<HTMLInputElement>('input[aria-label="How did Dal go?"]')!;
    input.value = 'Good, more lemon';
    buttonNamed(el, 'Save').click();
    expect(notes.addRecipeNote).toHaveBeenCalledWith('r-dal', '- Oct 19: Good, more lemon');
  });
});
