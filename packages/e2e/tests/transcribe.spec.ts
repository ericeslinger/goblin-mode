import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Transcribe (#47): from a photo's viewer, the app asks; a function
// claims it and calls Claude. The emulator has no Claude, so the round
// trip ends in a reason, shown where it was asked.

test('asking for a transcription reaches the server and comes back with its answer', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  const note = page.getByRole('textbox', { name: 'New note' });
  await note.click();
  await page.keyboard.type('Whiteboard');
  await page.evaluate(() => {
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([png], 'board.png', { type: 'image/png' }));
    document
      .querySelector('.cm-content')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
  });
  const image = note.getByRole('img', { name: 'board' });
  await expect(image).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'waiting to upload' })).toBeHidden({
    timeout: 15_000,
  });
  await letItSave(page);

  await image.click();
  const viewer = page.getByRole('dialog', { name: 'Image' });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: 'Transcribe' }).click();
  await expect(viewer.getByRole('status')).toContainText(
    'Not transcribed: Claude is not set up for this garden yet.',
    { timeout: 20_000 },
  );
  await expect(viewer.getByRole('button', { name: 'Try again' })).toBeVisible();
});
