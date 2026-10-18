import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Recipes (#127): with Kitchen on, a recipe is started from Browse,
// written like any note, read for its ingredients and steps, linked by
// name, and made by Claude with create_recipe.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('a recipe is started, written, linked and made by Claude', async ({ page }) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Kitchen' }).check();

  await page.goto('/browse/recipes');
  await page.getByRole('textbox', { name: 'New recipe' }).fill('Shakshuka');
  await page.getByRole('textbox', { name: 'New recipe' }).press('Enter');
  await expect(page).toHaveURL(/\/n\/\w+$/);
  const recipe = page.getByRole('region', { name: 'Recipe' });
  await expect(recipe.getByRole('textbox', { name: 'Recipe name' })).toHaveValue('Shakshuka');
  await expect(recipe).toContainText('0 ingredients · 0 steps');

  // Under Ingredients: the line after its heading.
  await note(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('- 2 onions, sliced');
  await letItSave(page);
  await expect(recipe).toContainText('1 ingredient · 0 steps');

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Serves' }).fill('2');
  await page.getByRole('spinbutton', { name: 'Serves' }).blur();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await expect(recipe).toContainText('serves 2');
  const url = page.url();

  // Its name answers to a link.
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Dinner Tuesday: [[Shakshuka]]', 'and salad']);
  await letItSave(page);
  await note(page).getByRole('link', { name: 'Shakshuka', exact: true }).click();
  await expect(page).toHaveURL(url);

  // Claude makes one, listed among the recipes.
  await call('create_recipe', {
    name: 'Red lentil dal',
    ingredients: ['1 cup red lentils', '1 tsp turmeric'],
    method: ['Rinse the lentils.', 'Simmer 20 minutes.'],
  });
  await page.goto('/browse/recipes');
  const list = page.getByRole('list', { name: 'Notes' });
  await expect(list).toContainText('Red lentil dal', { timeout: 15_000 });
  await expect(list).toContainText('Shakshuka');
  await list.getByRole('link', { name: /Red lentil dal/ }).click();
  await expect(recipe).toContainText('2 ingredients · 2 steps');
});
