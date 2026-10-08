import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Shared from another app (#42, #46): the manifest's share target posts
// to /share; the service worker keeps any files and opens the app at /
// with title, text and url, and a new note holds them all.

test('text shared from another app becomes a new note', async ({ page }) => {
  await signInAs(page, OWNER);
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.share_target).toMatchObject({ action: '/share', method: 'POST' });

  const params = new URLSearchParams({
    title: 'Seeds',
    text: 'what if seeds could talk',
    url: 'https://claude.ai/chat/1',
  });
  await page.goto(`/?${params}`);
  await expect(page).toHaveURL(/\/$/);
  const note = page.getByRole('textbox', { name: 'New note' });
  await expect(note).toContainText('what if seeds could talk');
  await expect(note).toContainText('https://claude.ai/chat/1');
  await letItSave(page);

  await page.goto('/browse');
  await expect(page.getByRole('list', { name: 'Notes' })).toContainText('Seeds');
});

test('files shared from another app land in a new note, through the service worker', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInAs(page, OWNER);
  // The app registers its worker once settled (at most 30 s); then a
  // reload puts the page under it, as an installed app always is.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 })
    .toBe(true);

  // What Android sends: a multipart POST to the share target.
  const landed = await page.evaluate(async () => {
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    const form = new FormData();
    form.set('text', 'the whiteboard');
    form.append('files', new File([png], 'board.png', { type: 'image/png' }));
    const res = await fetch('/share', { method: 'POST', body: form });
    return res.url;
  });
  expect(landed).toMatch(/\/\?text=the\+whiteboard&shared=1$/);
  await page.goto(landed);
  await expect(page).toHaveURL(/\/$/);
  const note = page.getByRole('textbox', { name: 'New note' });
  await expect(note).toContainText('the whiteboard');
  await expect(note.getByRole('img', { name: 'board' })).toBeVisible();
  await letItSave(page);
});

test('a pasted or dropped photo goes into the note', async ({ page }) => {
  await signInAs(page, OWNER);
  const note = page.getByRole('textbox', { name: 'New note' });
  await note.click();
  await page.keyboard.type('Receipts');
  await page.evaluate(() => {
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    const content = document.querySelector('.cm-content')!;
    for (const [type, name] of [
      ['paste', 'pasted.png'],
      ['drop', 'dropped.png'],
    ]) {
      const data = new DataTransfer();
      data.items.add(new File([png], name, { type: 'image/png' }));
      const event =
        type === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
      content.dispatchEvent(event);
    }
  });
  await expect(note.getByRole('img', { name: 'pasted' })).toBeVisible();
  await expect(note.getByRole('img', { name: 'dropped' })).toBeVisible();
  await letItSave(page);
});
