import AxeBuilder from '@axe-core/playwright';
import { expect, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The reading queue (#48): links saved to read later, newest first,
// marked read or unread, reached from Browse.

test('save a link to read later, then mark it read', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/browse');
  await page.getByRole('link', { name: /Reading queue/ }).click();
  await expect(page.getByRole('heading', { name: 'Reading queue', level: 1 })).toBeVisible();

  const link = page.getByRole('textbox', { name: 'Link to save' });
  await link.fill('not a link');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('not a link');
  await link.fill('https://example.com/papers/seeds');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  const queue = page.getByRole('list', { name: 'Reading queue' });
  await expect(queue.getByRole('link', { name: 'https://example.com/papers/seeds' })).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await queue.getByRole('button', { name: /^Mark read:/ }).click();
  await expect(queue.getByRole('button', { name: /^Mark unread:/ })).toBeVisible();
  await page.goto('/browse');
  await expect(page.getByRole('link', { name: /Reading queue/ })).not.toContainText('to read');
});
