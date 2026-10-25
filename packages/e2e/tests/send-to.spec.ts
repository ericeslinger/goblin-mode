import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Send to an assistant (#143): Eric sends a note from its back, with an
// ask; it waits until his assistant's routine checks (list_queue), does
// it, and says so (finish_queued); the back then shows what was done.
test('a note sent to an assistant waits in its queue, and shows what it did', async ({ page }) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  const { id } = (await call('create_note', { body: 'Glaze notes\nCeladon over the bisque' })) as {
    id: string;
  };
  await page.goto(`/n/${id}`);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const back = page.getByRole('region', { name: 'Back of the note' });
  await back.getByRole('textbox', { name: 'What should it do?' }).fill('File this under pottery');
  await back.getByRole('button', { name: 'Send' }).click();
  await expect(back.getByRole('status')).toContainText('Waiting for your assistant');
  await letItSave(page);

  await expect
    .poll(async () => (await call('list_queue', {})) as { id: string; ask?: string }[], {
      timeout: 15_000,
    })
    .toEqual([expect.objectContaining({ id, ask: 'File this under pottery' })]);
  const [{ sentAt }] = (await call('list_queue', {})) as { sentAt: string }[];
  await call('finish_queued', { id, sentAt, outcome: 'Linked it to pottery.' });
  await expect(back.getByRole('status')).toContainText('Done: Linked it to pottery.', {
    timeout: 15_000,
  });
  expect(await call('list_queue', {})).toEqual([]);

  // Settings gives the routine's prompt to copy.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Send to an assistant' })).toBeVisible();
  await expect(page.getByText('Call list_queue.', { exact: false })).toBeVisible();
});

// Do it now (#144 step 3): with an Anthropic key kept, the garden's own
// agent does the sent note at once. Under the emulator the model is a
// scripted stand-in that reads the note and finishes it.
test('Do it now runs the garden’s agent on the gardener’s key, and the back follows it', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await page.goto('/settings');
  const keys = page.getByRole('list', { name: 'API keys' });
  await keys
    .getByRole('textbox', { name: 'Anthropic key' })
    .fill('sk-ant-api03-e2e-abcdefghijklmnopqrstuvwxyz0123');
  await keys.getByRole('button', { name: 'Save' }).first().click();
  await expect(keys).toContainText('sk-ant-…0123');

  const call = await connectClaude(page);
  const { id } = (await call('create_note', { body: 'Seed order\nCeladon and shino' })) as {
    id: string;
  };
  await page.goto(`/n/${id}`);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const back = page.getByRole('region', { name: 'Back of the note' });
  await back.getByRole('button', { name: 'Send' }).click();
  await expect(back.getByRole('status')).toContainText('Waiting for your assistant');
  await letItSave(page);
  await back.getByRole('button', { name: 'Do it now' }).click();
  await expect(back.getByRole('status').first()).toContainText(
    'Done: Read it (emulator stand-in).',
    {
      timeout: 30_000,
    },
  );
  // The run's writes are the garden's own agent's.
  await page.getByRole('link', { name: 'All assistants’ changes' }).click();
  await expect(page.getByRole('list', { name: 'Changes' })).toContainText('Mossgoblin:');
});

// An item assigned with @goblin (#144 step 4): once the note settles, the
// assistant researches it (the emulator's stand-in answers without the
// web) and writes what it found under the item, ticked.
test('an item ending in @goblin is researched and answered under itself', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/settings');
  const keys = page.getByRole('list', { name: 'API keys' });
  await keys
    .getByRole('textbox', { name: 'Anthropic key' })
    .fill('sk-ant-api03-e2e-abcdefghijklmnopqrstuvwxyz0123');
  await keys.getByRole('button', { name: 'Save' }).first().click();
  await expect(keys).toContainText('sk-ant-…0123');

  await page.goto('/');
  const note = page.getByRole('textbox', { name: 'New note' });
  await note.click();
  await typeLines(page, ['Presents', '- [ ] good presents for my nephews @goblin']);
  await letItSave(page);
  // New settles the note, which is when assigned items are picked up.
  await page.getByRole('button', { name: 'New' }).click();
  await page.goto('/browse');
  await page
    .getByRole('list', { name: 'Notes' })
    .getByRole('link', { name: /Presents/ })
    .click();
  await expect(note).toContainText('Mossgoblin, from the web:', { timeout: 30_000 });
  await expect(note).toContainText('One thing, from https://example.com/one');
  await expect(note.locator('.cm-line').filter({ hasText: 'nephews @goblin' })).toContainText(
    '[x]',
  );
});
