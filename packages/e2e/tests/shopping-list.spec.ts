import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, openMore } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The shopping list (#39): a living template, made from Kitchen as its
// grocery list (#130); Claude adds to it under Produce, Butcher and Dry
// goods; in the store ticked items sink to Got it; Done shopping clears
// them, starred staples come back, and the old list stays in History.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('Claude fills the shopping list; ticks sink to Got it; Done shopping clears it', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  // The list is Kitchen's grocery list since #130: made from there.
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Kitchen' }).check();
  await letItSave(page);
  await page.reload();
  await page.getByRole('button', { name: 'Make the grocery list' }).click();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  const made = new URL(page.url()).pathname.split('/').pop();
  await page.goto('/settings');
  await expect(page.getByRole('link', { name: 'Grocery list' })).toBeVisible();
  await page
    .getByRole('list', { name: 'Templates' })
    .getByRole('link', { name: 'Shopping list' })
    .click();
  await expect(page.getByRole('region', { name: 'Template' })).toBeVisible();
  // Its mode and Instructions for Claude are on the back (#111, #112).
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Each use' })).toHaveValue('living');
  await expect(page.getByRole('textbox', { name: 'Instructions for Claude' })).toHaveValue(
    /Planned dinners/,
  );
  await page.getByRole('button', { name: 'Front', exact: true }).click();

  // "Help me make my grocery list", as Claude carries it out.
  // Once the template made on the phone has reached the server.
  const templates = () =>
    call('list_templates', {}) as Promise<{ id: string; instructions: string }[]>;
  await expect.poll(async () => (await templates()).length, { timeout: 15_000 }).toBe(1);
  const [template] = await templates();
  expect(template.instructions).toContain('plan_meal');
  // The note Kitchen made is the template's living note, once it has
  // reached the server (use_template would make one otherwise).
  await expect
    .poll(async () => (await call('get_note', { id: made }).catch(() => null)) !== null, {
      timeout: 15_000,
    })
    .toBe(true);
  const { note: living } = (await call('use_template', { id: template.id })) as {
    note: { id: string };
  };
  expect(living.id).toBe(made);
  const list = { id: made! };
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
    .toBe('Shopping list\n\n## Produce\n- [ ] onions\n\n## Butcher\n\n## Dry goods\n- [ ] rice ★');

  // The list before Done shopping is in History.
  await (await openMore(page)).getByRole('link', { name: 'History' }).click();
  await expect(page.getByRole('list', { name: 'Earlier versions' })).toContainText('[x] limes', {
    timeout: 15_000,
  });
});
