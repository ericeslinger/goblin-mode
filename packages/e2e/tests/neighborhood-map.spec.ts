import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, typeLines, openMore } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The neighborhood map (#32): a note's links and backlinks, two out.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('the map shows a note’s neighborhood; a node opens its note; back returns', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Studio day', 'Fire the [[Kiln]] with [[Glaze]].', 'clay']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Firing log', 'The [[Glaze]] ran.', 'notes']);
  await letItSave(page);

  await (await openMore(page)).getByRole('link', { name: 'Map' }).click();
  await expect(page).toHaveURL(/\/map\/n\/\w+$/);
  await expect(page.getByRole('heading', { name: 'Around Firing log' })).toBeVisible();
  const direct = page.getByRole('list', { name: 'Linked directly' });
  await expect(direct).toContainText('Glaze');
  const twoAway = page.getByRole('list', { name: 'Two links away' });
  await expect(twoAway).toContainText('Studio day');
  await expect(page.locator('svg.map .node')).toHaveCount(3);

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Tap a node in the drawing.
  await page.locator('svg.map .node', { hasText: 'Studio day' }).click();
  await expect(note(page)).toContainText('Studio day');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Around Firing log' })).toBeVisible();
});
