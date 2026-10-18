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
