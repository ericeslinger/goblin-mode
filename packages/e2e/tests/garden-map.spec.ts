import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The garden map (#33): every concept a bed of the notes that link it,
// and a timeline of the same notes, filterable to one concept.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('the garden shows beds and a timeline; a dot opens its note; back returns', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Studio day', 'Fire the [[Kiln]] with [[Glaze]].', 'clay']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Firing log', 'The [[Kiln]] ran hot.', 'notes']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Glaze recipe', 'A celadon [[Glaze]].', 'test tile']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();

  await page.goto('/browse');
  await page.getByRole('link', { name: 'See the whole garden as a map' }).click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.getByRole('list', { name: /^Kiln/ })).toContainText('Firing log');
  await expect(page.getByRole('list', { name: /^Glaze/ })).toContainText('Glaze recipe');
  await noSeriousViolations(page);

  // Tap a dot in the drawing.
  await page.locator('svg.map .node', { hasText: 'Firing log' }).click();
  await expect(note(page)).toContainText('Firing log');
  await page.goBack();
  await expect(page).toHaveURL(/\/map$/);

  const layouts = page.getByRole('navigation', { name: 'Layouts' });
  await layouts.getByRole('link', { name: 'Timeline' }).click();
  await expect(page).toHaveURL(/\/map\/timeline$/);
  const overTime = page.getByRole('region', { name: 'Over time' });
  await expect(overTime).toContainText('Firing log');
  await expect(overTime).toContainText('Glaze recipe');
  await page.getByRole('combobox', { name: /Show/ }).selectOption({ label: 'Glaze' });
  await expect(page).toHaveURL(/\/map\/timeline\?concept=c-glaze$/);
  await expect(overTime).toContainText('Glaze recipe');
  await expect(overTime).not.toContainText('Firing log');
  await noSeriousViolations(page);

  await page.goBack();
  await expect(page).toHaveURL(/\/map\/timeline$/);
  await expect(overTime).toContainText('Firing log');
});
