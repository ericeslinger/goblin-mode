import AxeBuilder from '@axe-core/playwright';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The meal plan (#129): a week opens as a note with its slots drawn
// above its text. A dinner is planned from the recipes, ticked made,
// and asked about; the answer lands under the slot and in the recipe,
// whose back counts how often it was made. Claude reads and plans the
// same note.

test('a week is planned, a dinner made and noted, and Claude plans too', async ({ page }) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Kitchen' }).check();
  await letItSave(page);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Kitchen' })).toBeChecked();

  await page.goto('/browse/recipes');
  await page.getByRole('textbox', { name: 'New recipe' }).fill('Shakshuka');
  await page.getByRole('textbox', { name: 'New recipe' }).press('Enter');
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await letItSave(page);

  await page.goto('/kitchen/2026-10-21');
  await expect(page).toHaveURL(/\/n\/meals-2026-10-19$/);
  const plan = page.getByRole('region', { name: 'Meal plan' });
  await expect(plan.getByRole('list', { name: 'Meals' }).getByRole('listitem')).toHaveCount(7);
  await expect(plan).toContainText('Fish of the week');

  await plan.getByRole('button', { name: 'Change Mon dinner, Oct 19: nothing planned' }).click();
  await plan.getByRole('combobox', { name: 'Recipe for Mon dinner, Oct 19' }).fill('Shakshuka');
  await plan.getByRole('button', { name: 'Plan it' }).click();
  await expect(plan).toContainText('[[Shakshuka]]');
  await plan.getByRole('button', { name: 'Change Tue dinner, Oct 20: nothing planned' }).click();
  await plan.getByRole('button', { name: 'Delivery' }).click();
  await expect(page.getByRole('textbox', { name: 'New note' })).toContainText(
    'Tue dinner: delivery',
  );

  await plan.getByRole('checkbox', { name: 'Made Mon dinner, Oct 19' }).check();
  const ask = plan.getByRole('textbox', { name: 'How did Shakshuka go?' });
  await ask.fill('Lovely, more chili');
  await plan.getByRole('button', { name: 'Save' }).click();
  await expect(plan).toContainText('Lovely, more chili');
  await expect(ask).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await letItSave(page);

  // Claude reads the same week and plans the fish.
  const read = (await call('get_meal_plan', { date: '2026-10-19' })) as {
    slots: { day: string; made: boolean; notes: string[] }[];
  };
  expect(read.slots[0]).toMatchObject({ day: 'Mon', made: true, notes: ['Lovely, more chili'] });
  await call('create_recipe', { name: 'Miso cod', ingredients: ['cod'], method: ['Bake.'] });
  await call('plan_meal', { date: '2026-10-22', slot: '[[Miso cod]]' });
  await expect(plan).toContainText('[[Miso cod]]', { timeout: 15_000 });

  // The recipe's back counts the dinner, and its Notes hold the answer.
  await page.goto('/browse/recipes');
  await page
    .getByRole('list', { name: 'Notes' })
    .getByRole('link', { name: /Shakshuka/ })
    .click();
  await expect(page.getByRole('textbox', { name: 'New note' })).toContainText(
    'Oct 19: Lovely, more chili',
  );
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Back of the note' })).toContainText(
    'Made once, last Oct 19',
  );
});

// Kitchen's settings shape the weeks not planned yet; a week opens its
// neighbours; a made dinner's question can wait for a reminder.
test('Kitchen settings shape new weeks, and a question waits for later', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Kitchen' }).check();
  await letItSave(page);
  await page.reload();
  await page.getByRole('combobox', { name: 'Weeks start on' }).selectOption('Sun');
  await page.getByRole('checkbox', { name: 'lunch' }).check();
  await page.getByRole('combobox', { name: 'Fish of the week on' }).selectOption('none');
  await page
    .getByRole('button', { name: 'Remind me each week, the day before it starts, at 4 pm' })
    .click();
  await expect(page.getByText('Each week you are reminded to plan')).toBeVisible();
  await letItSave(page);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Weeks start on' })).toHaveValue('Sun');

  await page.goto('/kitchen/2026-11-04');
  await expect(page).toHaveURL(/\/n\/meals-2026-11-01$/);
  const plan = page.getByRole('region', { name: 'Meal plan' });
  const meals = plan.getByRole('list', { name: 'Meals' }).getByRole('listitem');
  await expect(meals).toHaveCount(14);
  await expect(meals.first()).toContainText('Sun lunch, Nov 1');
  await expect(plan).not.toContainText('Fish of the week');

  await plan.getByRole('link', { name: 'Previous week' }).click();
  await expect(page).toHaveURL(/\/n\/meals-2026-10-25$/);
  await plan.getByRole('link', { name: 'Next week' }).click();
  await expect(page).toHaveURL(/\/n\/meals-2026-11-01$/);

  await plan.getByRole('button', { name: 'Change Mon dinner, Nov 2: nothing planned' }).click();
  await plan.getByRole('button', { name: 'Delivery' }).click();
  await plan.getByRole('checkbox', { name: 'Made Mon dinner, Nov 2' }).check();
  await plan.getByRole('button', { name: 'Ask me later' }).click();
  await expect(plan.getByRole('textbox', { name: 'What was it, and from where?' })).toHaveCount(0);
  await letItSave(page);
  await page.goto('/right-now');
  await expect(page.getByRole('main')).toContainText(
    'What was it, and from where? (Mon dinner, Nov 2)',
  );
});

// The grocery list (#130), shopped from a planned week end to end: a
// planned dinner adds its ingredients, naming it; what is listed is
// skipped; a changed dinner takes its lines off; after shopping, an item
// goes back under the section it was filed in.
test('a planned week fills the grocery list, and shopping it clears it', async ({ page }) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Kitchen' }).check();
  await letItSave(page);
  await page.reload();
  await page.getByRole('button', { name: 'Make the grocery list' }).click();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  const list = new URL(page.url()).pathname.split('/').pop()!;
  await letItSave(page);
  await expect
    .poll(
      async () => ((await call('get_note', { id: list }).catch(() => null)) as unknown) !== null,
      {
        timeout: 15_000,
      },
    )
    .toBe(true);
  await call('add_lines', { id: list, heading: 'Produce', lines: ['- [ ] limes'] });
  await call('create_recipe', {
    name: 'Shakshuka',
    ingredients: ['2 onions, sliced', '400 g tomatoes', 'limes'],
    method: ['Cook.'],
  });
  await call('create_recipe', { name: 'Dal', ingredients: ['1 cup lentils', 'limes'], method: [] });

  // Planned in the app: its lines go on, the listed limes skipped.
  await page.goto('/kitchen/2026-10-19');
  const plan = page.getByRole('region', { name: 'Meal plan' });
  await plan.getByRole('button', { name: 'Change Mon dinner, Oct 19: nothing planned' }).click();
  await plan.getByRole('combobox', { name: 'Recipe for Mon dinner, Oct 19' }).fill('Shakshuka');
  await plan.getByRole('button', { name: 'Plan it' }).click();
  await expect(plan.getByRole('status')).toHaveText('Added 2 lines to the grocery list.');
  // Saved before Claude plans: an edit on each side within the same
  // moment is the sync merge's case (#37), not this journey's.
  await letItSave(page);
  // Planned by Claude, half a recipe.
  await call('plan_meal', { date: '2026-10-20', slot: '[[Dal]] (half recipe)' });
  const listBody = async () => ((await call('get_note', { id: list })) as { body: string }).body;
  await expect.poll(listBody, { timeout: 15_000 }).toContain('0.5 cup lentils (Dal, Tue)');
  const body = await listBody();
  expect(body).toContain('## From recipes');
  expect(body).toContain('- [ ] 2 onions, sliced (Shakshuka, Mon)');
  expect(body).not.toContain('limes (Shakshuka, Mon)');

  // Monday becomes delivery: Shakshuka's lines come off. The phone has
  // Claude's Tuesday first.
  await expect(plan).toContainText('[[Dal]] (half recipe)', { timeout: 15_000 });
  await plan.getByRole('button', { name: /^Change Mon dinner, Oct 19/ }).click();
  await plan.getByRole('button', { name: 'Delivery' }).click();
  await expect(plan.getByRole('status')).toHaveText('Took 2 lines off the grocery list.');
  await expect.poll(listBody, { timeout: 15_000 }).not.toContain('(Shakshuka, Mon)');

  // Shopping: limes and lentils ticked, then Done shopping.
  await plan.getByRole('link', { name: 'Grocery list' }).click();
  await expect(page).toHaveURL(new RegExp(`/n/${list}$`));
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const view = page.getByRole('region', { name: 'List' });
  await view.getByRole('checkbox', { name: 'limes' }).check();
  await view.getByRole('checkbox', { name: '0.5 cup lentils (Dal, Tue)' }).check();
  const got = view.getByRole('list', { name: 'Got it' });
  await expect(got).toContainText('limes');
  await expect(got).toContainText('0.5 cup lentils (Dal, Tue)');
  await view.getByRole('button', { name: 'Done shopping' }).click();
  await expect(view.getByRole('list', { name: 'Got it' })).toHaveCount(0);
  await letItSave(page);

  // What was bought is on hand (#131); a made dinner uses its share up.
  const pantry = async () =>
    ((await call('get_pantry', {})) as { items: { item: string }[] }).items.map((i) => i.item);
  await expect.poll(pantry, { timeout: 15_000 }).toEqual(['limes', 'lentils']);
  await page.goto('/kitchen/2026-10-19');
  await plan.getByRole('checkbox', { name: 'Made Tue dinner, Oct 20' }).check();
  await expect(plan.getByRole('status')).toHaveText('Used up: limes, lentils.');
  await letItSave(page);
  await expect.poll(pantry, { timeout: 15_000 }).toEqual([]);

  // Next week, limes go back under Produce, where they were filed; and
  // tomatoes, on hand now, are not shopped for.
  await call('update_pantry', { add: [{ item: 'tomatoes', section: 'Produce' }] });
  await call('plan_meal', { date: '2026-10-26', slot: '[[Shakshuka]]' });
  await expect
    .poll(listBody, { timeout: 15_000 })
    .toMatch(/## Produce\n(?:.*\n)*?- \[ \] limes \(Shakshuka, Mon\)/);
  expect(await listBody()).toContain('2 onions, sliced (Shakshuka, Mon)');
  expect(await listBody()).not.toContain('tomatoes (Shakshuka, Mon)');

  // Picking a dinner offers recipes to cook (#132); a tap plans one.
  await page.goto('/kitchen/2026-10-28');
  await plan.getByRole('button', { name: 'Change Wed dinner, Oct 28: nothing planned' }).click();
  const ideas = plan.getByRole('list', { name: 'Suggestions for Wed dinner, Oct 28' });
  await expect(ideas).toContainText('Dal');
  await ideas.getByRole('button', { name: 'Plan Dal' }).click();
  await expect(
    plan.getByRole('button', { name: 'Change Wed dinner, Oct 28: [[Dal]]' }),
  ).toBeVisible();
});
