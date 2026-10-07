import AxeBuilder from '@axe-core/playwright';
import { expect, letItSave, openMore, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The launch screen's top bar (#78): New, From template and List stay;
// the rest is in More, whose button carries the sync dot.

test('More holds the rest of the bar, and its dot shows offline', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['A note to share']);
  await letItSave(page);

  const more = page.getByRole('button', { name: 'More' });
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  const menu = await openMore(page);
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(menu).toContainText('Synced');
  for (const name of ['Map', 'History', 'Settings', 'Browse']) {
    await expect(menu.getByRole('link', { name })).toBeVisible();
  }
  await expect(menu.getByRole('button', { name: 'Copy link' })).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Escape closes it, back on its button.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  // Offline shows on the button without opening anything.
  await page.context().setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'offline' })).toHaveCount(1);
  await expect(more.locator('.sync')).toHaveClass(/offline/);
  await expect(await openMore(page)).toContainText('Offline.');
  await page.context().setOffline(false);
  await expect(more.locator('.sync')).not.toHaveClass(/offline/);

  // Choosing an item closes More and does it.
  await (await openMore(page)).getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('navigation', { name: 'More' })).toHaveCount(0);
});
