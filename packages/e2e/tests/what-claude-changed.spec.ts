import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// What Claude changed (#34): Claude organizes through MCP, and the app
// lists each change with the notes it touched and their History.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('a merge by Claude shows in What Claude changed, with its notes and History', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Kiln log', 'Cone 6, slow cool.']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Firing notes', 'Shelf 2 cracked.']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();

  const call = await connectClaude(page);
  const listed = (await call('search_notes', { query: 'kiln' })) as { id: string }[];
  const [kiln] = listed;
  const [firing] = (await call('search_notes', { query: 'shelf' })) as { id: string }[];
  const merged = (await call('merge_notes', { ids: [kiln.id, firing.id] })) as { id: string };

  await page.goto('/browse');
  await page.getByRole('link', { name: 'What Claude changed' }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole('heading', { name: 'What Claude changed' })).toBeVisible();
  const touched = page.getByRole('list', { name: 'Notes: Merged 2 notes into one' });
  await expect(touched.getByRole('link', { name: 'Firing notes', exact: true })).toBeVisible();
  await expect(touched).toContainText('archived');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // The merged note holds both, word for word.
  await touched.getByRole('link', { name: 'Kiln log', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/n/${merged.id}$`));
  await expect(note(page)).toContainText('Cone 6, slow cool.');
  await expect(note(page)).toContainText('Shelf 2 cracked.');
  await page.goBack();

  // An original's History is a tap away.
  await touched.getByRole('link', { name: 'History of Firing notes' }).click();
  await expect(page).toHaveURL(new RegExp(`/history\\?note=${firing.id}$`));
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
});
