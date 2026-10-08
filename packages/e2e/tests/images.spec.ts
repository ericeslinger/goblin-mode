import AxeBuilder from '@axe-core/playwright';
import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Photos in notes (#44): attached with no network, shown at once from
// the device, uploaded when the network is back, and shown from Storage
// after a reload. A mouse context: the toolbar holds Insert image.
test.use({ isMobile: false, hasTouch: false, viewport: { width: 1200, height: 800 } });

// A 4x4 red PNG, valid enough for the thumbnail function to read.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWM4Y2wMRwzEcQD7ExMhwLzAsQAAAABJRU5ErkJggg==',
  'base64',
);

test('a photo attached offline shows at once and uploads when back online', async ({
  page,
  context,
}) => {
  await signInAs(page, OWNER);
  const note = page.getByRole('textbox', { name: 'New note' });
  await expect(note).toBeFocused();
  await page.keyboard.type('Dinner');
  await letItSave(page);

  await context.setOffline(true);
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('toolbar', { name: 'Formatting' })
    .getByRole('button', { name: 'Insert image' })
    .click();
  await (await chooser).setFiles({ name: 'menu.png', mimeType: 'image/png', buffer: PNG });

  const photo = page.getByRole('img', { name: 'menu' });
  await expect(photo).toBeVisible();
  const waiting = page.getByRole('status').filter({ hasText: 'waiting to upload' });
  await expect(waiting).toHaveText('1 photo waiting to upload');

  await context.setOffline(false);
  await expect(waiting).toBeHidden({ timeout: 15_000 });
  await letItSave(page);

  // From Storage now, not the device's copy.
  await page.reload();
  await expect(page.getByRole('img', { name: 'menu' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('img', { name: 'menu' }).click();
  const viewer = page.getByRole('dialog', { name: 'Image' });
  await expect(viewer).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();
});
