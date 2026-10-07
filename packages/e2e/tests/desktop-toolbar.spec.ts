import AxeBuilder from '@axe-core/playwright';
import { expect, letItSave, openMore, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// With a mouse there is no on-screen keyboard to ride on, so the
// formatting actions sit in a toolbar over the note (2026-10-07, Eric:
// lists and the rest by mouse). Clicks leave the cursor in the note.
test.use({ isMobile: false, hasTouch: false, viewport: { width: 1200, height: 800 } });

test('the desktop toolbar formats by mouse and keeps the cursor in the note', async ({ page }) => {
  await signInAs(page, OWNER);
  const note = page.getByRole('textbox', { name: 'New note' });
  await expect(note).toBeFocused();
  const tools = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(tools).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Bold' })).toHaveAttribute(
    'title',
    'Bold (Ctrl+B)',
  );
  await page.keyboard.type('Plans');
  await page.keyboard.press('Enter');
  await page.keyboard.type('dinner');
  await tools.getByRole('button', { name: 'Bulleted list' }).click();
  await expect(note).toBeFocused();
  await page.keyboard.type(' tomorrow');
  await tools.getByRole('button', { name: 'Checklist item' }).click();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await letItSave(page);

  await (await openMore(page)).getByRole('button', { name: 'Source' }).click();
  await expect(note).toHaveText(['Plans', '- [ ] dinner tomorrow'].join(''));
});
