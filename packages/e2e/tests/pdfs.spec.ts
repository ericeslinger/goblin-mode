import AxeBuilder from '@axe-core/playwright';
import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// PDFs in notes (#45): attached offline like photos, shown as a chip,
// and opened in a document viewer that draws the pages with pdf.js.
test.use({ isMobile: false, hasTouch: false, viewport: { width: 1200, height: 800 } });

// A one-page PDF that says "Menu: soup".
const PDF = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMTAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0MCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDUwIFRkIChNZW51OiBzb3VwKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMzMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwMQolJUVPRgo=',
  'base64',
);

test('a PDF attached offline shows as a chip and opens in the document viewer', async ({
  page,
  context,
}) => {
  await signInAs(page, OWNER);
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeFocused();
  await page.keyboard.type('Dinner');
  await letItSave(page);

  await context.setOffline(true);
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('toolbar', { name: 'Formatting' })
    .getByRole('button', { name: 'Attach PDF' })
    .click();
  await (await chooser).setFiles({ name: 'menu.pdf', mimeType: 'application/pdf', buffer: PDF });
  const chip = page.getByRole('button', { name: 'Open menu.pdf' });
  await expect(chip).toBeVisible();
  const waiting = page.getByRole('status').filter({ hasText: 'waiting to upload' });
  await expect(waiting).toHaveText('1 file waiting to upload');

  await context.setOffline(false);
  await expect(waiting).toBeHidden({ timeout: 15_000 });
  await letItSave(page);

  // From Storage now.
  await page.reload();
  await page.getByRole('button', { name: 'Open menu.pdf' }).click();
  const viewer = page.getByRole('dialog', { name: 'menu.pdf' });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('img', { name: 'Page 1' })).toBeVisible({ timeout: 15_000 });
  await expect(viewer.getByRole('link', { name: 'Save' })).toBeVisible();
  // Find in this PDF (#45), on the device.
  const find = viewer.getByRole('searchbox', { name: 'Find in this PDF' });
  await find.fill('SOUP');
  await find.press('Enter');
  await expect(viewer.getByRole('button', { name: '1', exact: true })).toBeVisible();
  await find.fill('lobster');
  await find.press('Enter');
  await expect(viewer.getByText('Not found')).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();

  // Again in the same session: the shared pdf.js worker outlives a
  // closed document (review on #94), and the page is really drawn.
  await page.getByRole('button', { name: 'Open menu.pdf' }).click();
  const pageOne = viewer.getByRole('img', { name: 'Page 1' });
  await expect(pageOne).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => pageOne.evaluate((c) => (c as HTMLCanvasElement).width), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();
});
