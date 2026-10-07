import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, signInAs, test, openMore } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The shopping list (#39): a living template; Claude adds what the meal
// plan needs under Produce, Butcher and Dry goods; in the store ticked
// items sink to Got it; Done shopping clears them, starred staples come
// back, and the old list stays in History.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('Claude fills the shopping list; ticks sink to Got it; Done shopping clears it', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Add a shopping list' }).click();
  await expect(page.getByRole('region', { name: 'Template' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Each use' })).toHaveValue('living');

  // "Help me make my grocery list", as Claude carries it out.
  // Once the template made on the phone has reached the server.
  const templates = () =>
    call('list_templates', {}) as Promise<{ id: string; instructions: string }[]>;
  await expect.poll(async () => (await templates()).length, { timeout: 15_000 }).toBe(1);
  const [template] = await templates();
  expect(template.instructions).toContain('Meal plan');
  const { note: list } = (await call('use_template', { id: template.id })) as {
    note: { id: string };
  };
  await call('add_lines', { id: list.id, heading: 'Meal plan', lines: ['Tacos Tuesday'] });
  await call('add_lines', {
    id: list.id,
    heading: 'Produce',
    lines: ['- [ ] limes', '- [ ] onions'],
  });
  await call('add_lines', { id: list.id, heading: 'Dry goods', lines: ['- [ ] rice ★'] });

  await page.goto('/');
  await page.getByRole('button', { name: 'From template' }).click();
  await page
    .getByRole('list', { name: 'Templates' })
    .getByRole('button', { name: 'Shopping list' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/n/${list.id}$`));
  await expect(note(page)).toContainText('limes');

  await page.getByRole('button', { name: 'List', exact: true }).click();
  const view = page.getByRole('region', { name: 'List' });
  await expect(view.getByRole('list', { name: 'Produce' })).toContainText('limes');
  await view.getByRole('checkbox', { name: 'limes' }).check();
  await view.getByRole('checkbox', { name: 'rice ★' }).check();
  const got = view.getByRole('list', { name: 'Got it' });
  await expect(got).toContainText('limes');
  await expect(got).toContainText('rice ★');
  await expect(view.getByRole('list', { name: 'Produce' })).not.toContainText('limes');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await view.getByRole('button', { name: 'Done shopping' }).click();
  await expect(got).toHaveCount(0);
  await expect(view.getByRole('list', { name: 'Dry goods' })).toContainText('rice ★');
  await expect(view.getByRole('checkbox', { name: 'rice ★' })).not.toBeChecked();
  await expect
    .poll(async () => ((await call('get_note', { id: list.id })) as { body: string }).body, {
      timeout: 15_000,
    })
    .toBe(
      'Shopping list\n\n## Meal plan\nTacos Tuesday\n\n## Produce\n- [ ] onions\n\n## Butcher\n\n## Dry goods\n- [ ] rice ★',
    );

  // The list before Done shopping is in History.
  await (await openMore(page)).getByRole('link', { name: 'History' }).click();
  await expect(page.getByRole('list', { name: 'Earlier versions' })).toContainText('[x] limes', {
    timeout: 15_000,
  });
});
