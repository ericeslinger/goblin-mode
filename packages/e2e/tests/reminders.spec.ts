import type { Page } from '@playwright/test';
import { expect, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

/** A datetime-local value `minutes` from now, in the browser's own zone. */
function localTime(page: Page, minutes: number): Promise<string> {
  return page.evaluate((m) => {
    const d = new Date(Date.now() + m * 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, minutes);
}

async function addReminder(
  page: Page,
  text: string,
  { inMinutes, repeat }: { inMinutes?: number; repeat?: string } = {},
): Promise<void> {
  await page.getByRole('button', { name: 'Add a reminder' }).click();
  await page.getByRole('textbox', { name: 'Reminder', exact: true }).fill(text);
  if (inMinutes !== undefined) await page.getByLabel(/When/).fill(await localTime(page, inMinutes));
  if (repeat) await page.getByLabel('Repeat').selectOption(repeat);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
}

const section = (page: Page, name: string) => page.getByRole('region', { name });
const rightNow = (page: Page) => page.getByRole('region', { name: 'Right Now' });

test('add a reminder, see it in Right Now, then done and undo', async ({ page }) => {
  await signInAs(page, OWNER);
  await rightNow(page).getByRole('link', { name: 'Right Now' }).click();
  await expect(page.getByRole('heading', { name: 'Right Now', level: 1 })).toBeVisible();

  await addReminder(page, 'Call the bank', { inMinutes: -60 });
  await addReminder(page, 'Learn the banjo');
  await expect(section(page, 'Overdue')).toContainText('Call the bank');
  await expect(section(page, 'Someday')).toContainText('Learn the banjo');

  await addReminder(page, 'Fetch the kiln shelf', { inMinutes: 2 * 24 * 60 });

  // Home (#219) names what is due today, not a later day's reminder or
  // Someday's; then its box, back to the editor.
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.locator('a.right-now')).toContainText('Call the bank');
  await expect(page.locator('a.right-now')).not.toContainText('Fetch the kiln shelf');
  await expect(page.locator('a.right-now')).not.toContainText('Learn the banjo');
  await page.getByRole('link', { name: 'Plant a thought' }).click();
  await expect(rightNow(page)).toContainText('Call the bank');
  await expect(rightNow(page)).not.toContainText('Learn the banjo');

  await rightNow(page).getByRole('button', { name: 'Done: Call the bank' }).click();
  await expect(rightNow(page)).toContainText('Nothing to tend.');
  await rightNow(page).getByRole('button', { name: 'Undo' }).click();
  await expect(rightNow(page)).toContainText('Call the bank');

  // Still there for a fresh load: it was written, not just shown.
  await page.reload();
  await expect(rightNow(page)).toContainText('Call the bank');
});

test('snooze moves a reminder out of Overdue until later', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/right-now');
  await addReminder(page, 'Water the plants', { inMinutes: -5 });
  await expect(section(page, 'Overdue')).toContainText('Water the plants');

  await page.getByRole('button', { name: 'Snooze: Water the plants' }).click();
  await page.getByRole('button', { name: 'In an hour' }).click();
  await expect(section(page, 'Overdue')).toHaveCount(0);
  await expect(page.getByText(/snoozed until/)).toBeVisible();
});

test('done on a daily reminder moves it to its next time', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/right-now');
  await addReminder(page, 'Journal', { inMinutes: -1, repeat: 'Daily' });
  await expect(section(page, 'Overdue')).toContainText('Journal');

  await page.getByRole('button', { name: 'Done: Journal' }).click();
  await expect(section(page, 'Overdue')).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'Journal' })).toContainText('daily');
  await expect(page.getByRole('status')).toContainText('Done until next time');
});

test('swiping a reminder right marks it done, left offers snooze', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/right-now');
  await addReminder(page, 'Stretch', { inMinutes: -1 });
  await addReminder(page, 'Reply to Vikas', { inMinutes: -2 });
  // Both in place first: the second one sorts above the first.
  await expect(page.getByRole('listitem')).toHaveText([/Reply to Vikas/, /Stretch/]);

  const swipe = async (text: string, dx: number) => {
    const row = page.getByRole('listitem').filter({ hasText: text });
    const box = (await row.boundingBox())!;
    const y = box.y + box.height / 2;
    const x = box.x + box.width / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 4 });
    await page.mouse.move(x + dx, y, { steps: 4 });
    await page.mouse.up();
  };

  await swipe('Stretch', 120);
  await expect(page.getByRole('listitem').filter({ hasText: 'Stretch' })).toHaveCount(0);

  await swipe('Reply to Vikas', -120);
  await expect(page.getByRole('group', { name: 'Snooze Reply to Vikas until' })).toBeVisible();
});

// Since #289 (Eric, 2026-11-15) Right Now on a wide screen is the
// rail's entry, with its count, and its own screen; until then it sat
// above all notes.
test('wide screens put Right Now in the rail, with what is due', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/right-now');
  await addReminder(page, 'Buy stamps', { inMinutes: -1 });
  // Home (#219), then its box, back to the editor.
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link', { name: 'Plant a thought' }).click();
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.getByRole('complementary', { name: 'All notes' })).toBeVisible();
  await expect(rightNow(page)).toHaveCount(0);
  const entry = page
    .getByRole('navigation', { name: 'Places', exact: true })
    .getByRole('link', { name: 'Right Now, 1 due', exact: true });
  await entry.click();
  await expect(page).toHaveURL(/\/right-now$/);
  await expect(section(page, 'Overdue')).toContainText('Buy stamps');
});
