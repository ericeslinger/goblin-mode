import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Context for Claude (#113): one note, opened from Settings, that Claude
// is given on every connection and reads with get_context; it stays out
// of the note lists. The back of the note (#112) says when it was made
// and what Claude changed on it.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('Context for Claude reaches Claude, and shows on the back what Claude added', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Context for Claude' }).click();
  await expect(page).toHaveURL(/\/n\/context$/);
  await expect(page.getByText('0 of 4000 characters')).toBeVisible();
  await note(page).click();
  await typeLines(page, ['Fish comes most Wednesdays.']);
  await letItSave(page);
  await expect(page.getByText('27 of 4000 characters')).toBeVisible();

  await expect
    .poll(async () => ((await call('get_context', {})) as { text: string }).text, {
      timeout: 15_000,
    })
    .toBe('Fish comes most Wednesdays.');
  await call('add_lines', { id: 'context', lines: ['✳ Claude: Eric shops on Saturdays.'] });
  await expect(note(page)).toContainText('Eric shops on Saturdays.', { timeout: 15_000 });

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const back = page.getByRole('region', { name: 'Back of the note' });
  await expect(back).toContainText('Made');
  await expect(back.getByRole('list', { name: 'What Claude changed' })).toContainText(
    'Context for Claude',
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Not a note among the notes.
  await page.goto('/browse');
  await expect(page.getByText('No notes planted yet.')).toBeVisible();
});
