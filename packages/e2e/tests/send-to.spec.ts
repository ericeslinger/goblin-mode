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
  // The item is ticked: the editor draws the box as a widget, with this class.
  await expect(note.locator('.cm-line').filter({ hasText: 'nephews @goblin' })).toHaveClass(
    /mg-done/,
  );
});

// Garden on arrival (#214, step 1 of #155): with the switch on and an
// Anthropic key kept, a new note is sent once it first settles, with
// no ask, and the garden's agent (the emulator's stand-in) finishes it.
// Leave it alone (#229): a note held on its back, a note made from a
// template Settings skips, and a note with a tag it names, are not sent.
test('a new note is gardened on arrival once it settles, and its back says so', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAs(page, OWNER);
  await page.goto('/settings');
  const keys = page.getByRole('list', { name: 'API keys' });
  await keys
    .getByRole('textbox', { name: 'Anthropic key' })
    .fill('sk-ant-api03-e2e-abcdefghijklmnopqrstuvwxyz0123');
  await keys.getByRole('button', { name: 'Save' }).first().click();
  await expect(keys).toContainText('sk-ant-…0123');
  const toggle = page.getByRole('switch', { name: 'Garden new notes on arrival' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await letItSave(page);

  await page.goto('/');
  const note = page.getByRole('textbox', { name: 'New note' });
  await note.click();
  await typeLines(page, ['Kiln log', 'Cone 6 firing on Saturday']);
  await letItSave(page);
  // New settles the note: its arrival.
  await page.getByRole('button', { name: 'New' }).click();
  await page.goto('/browse');
  await page
    .getByRole('list', { name: 'Notes' })
    .getByRole('link', { name: /Kiln log/ })
    .click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const back = page.getByRole('region', { name: 'Back of the note' });
  await expect(back.getByText('Sent on arrival', { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await expect(back.getByRole('status').first()).toContainText(
    'Done: Read it (emulator stand-in).',
    { timeout: 30_000 },
  );
  // Its text is as Eric left it.
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await expect(note).toContainText('Cone 6 firing on Saturday');

  // Leave this note alone, on its back before it settles.
  await page.goto('/');
  await page.getByRole('button', { name: 'New' }).click();
  await note.click();
  await typeLines(page, ['Letter to Dad', 'Not for filing']);
  await letItSave(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const hold = back.getByRole('switch', { name: 'Leave this note alone' });
  await hold.check();
  await expect(hold).toBeChecked();
  await letItSave(page);
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await page.getByRole('button', { name: 'New' }).click();

  // A template whose notes Settings says are never gardened on arrival.
  await page.goto('/settings');
  await page.getByRole('button', { name: 'New template', exact: true }).click();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await note.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await typeLines(page, ['Pottery journal', 'Fired: ']);
  await letItSave(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(back.getByRole('heading', { level: 2, name: 'Pottery journal' })).toBeVisible();
  await page.goto('/settings');
  const skip = page.getByRole('checkbox', { name: 'Notes made from Pottery journal' });
  await skip.check();
  await expect(skip).toBeChecked();
  await letItSave(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'From template' }).click();
  await page
    .getByRole('list', { name: 'Templates' })
    .getByRole('button', { name: 'Pottery journal' })
    .click();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await note.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('bisque, cone 04');
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();

  // A tag Settings names, typed with a # and a stray space, kept tidy
  // across a reload; the assistant tags a note, and Eric's next line
  // settles it unsent.
  await page.goto('/settings');
  const tags = page.getByRole('textbox', { name: 'Notes with these tags' });
  await tags.fill('private, #journal ');
  await tags.press('Tab');
  await letItSave(page);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Notes with these tags' })).toHaveValue(
    'private, journal',
  );
  const call = await connectClaude(page);
  await page.goto('/');
  await note.click();
  await typeLines(page, ['Letter to Mum', 'Birthday plans']);
  await letItSave(page);
  const [mum] = (await call('search_notes', { query: 'Birthday' })) as { id: string }[];
  await call('refile', { id: mum.id, addTags: ['private'] });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(back.getByRole('list', { name: 'Tags' })).toContainText('private');
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await note.click();
  await page.keyboard.press('ControlOrMeta+End');
  await typeLines(page, ['', 'Cake on Sunday']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();

  // A plain note settled after all three is sent: by then they would be.
  await note.click();
  await typeLines(page, ['Glaze order', 'Celadon and shino']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  const backOf = async (title: RegExp) => {
    await page.goto('/browse');
    await page.getByRole('list', { name: 'Notes' }).getByRole('link', { name: title }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
  };
  await backOf(/Glaze order/);
  await expect(back.getByText('Sent on arrival', { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  for (const title of [/Letter to Dad/, /Pottery journal/, /Letter to Mum/]) {
    await backOf(title);
    await expect(
      back.getByRole('heading', { level: 3, name: 'Send to an assistant' }),
    ).toBeVisible();
    await expect(back.getByText('Sent on arrival', { exact: false })).toHaveCount(0);
  }
});

// Split a ramble (#233, step 4 of #155): a capture holding several
// thoughts becomes a note a thought before it is filed. The stand-in
// splits a note a paragraph a part when its first line says "ramble";
// each piece links back, and Put back makes the note whole again.
test('a ramble is split on arrival into a note a thought, and Put back makes it whole', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInAs(page, OWNER);
  await page.goto('/settings');
  const keys = page.getByRole('list', { name: 'API keys' });
  await keys
    .getByRole('textbox', { name: 'Anthropic key' })
    .fill('sk-ant-api03-e2e-abcdefghijklmnopqrstuvwxyz0123');
  await keys.getByRole('button', { name: 'Save' }).first().click();
  await expect(keys).toContainText('sk-ant-…0123');
  const toggle = page.getByRole('switch', { name: 'Garden new notes on arrival' });
  await toggle.check();
  await expect(toggle).toBeChecked();
  await letItSave(page);

  await page.goto('/');
  const note = page.getByRole('textbox', { name: 'New note' });
  await note.click();
  await typeLines(page, [
    'Drive home ramble',
    'Order more kiln shelves before the next firing',
    '',
    'Find a birthday present for Sam',
  ]);
  await letItSave(page);
  // New settles the note: its arrival.
  await page.getByRole('button', { name: 'New' }).click();

  // Browse lists the note and the one piece split off it.
  await page.goto('/browse');
  const list = page.getByRole('list', { name: 'Notes' });
  const original = list.getByRole('link', { name: /^Drive home ramble/ });
  const piece = list.getByRole('link', { name: /^Find a birthday present/ });
  await expect(piece).toBeVisible({ timeout: 30_000 });
  await expect(original).toBeVisible();

  // The note keeps its first thought, word for word, and links the piece.
  await original.click();
  await expect(note).toContainText('Order more kiln shelves before the next firing');
  await expect(note).toContainText('Split off:');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const back = page.getByRole('region', { name: 'Back of the note' });
  await expect(back.getByRole('status').first()).toContainText(
    'Done: Split it into 2 notes (emulator stand-in).',
    { timeout: 30_000 },
  );
  const originalUrl = page.url();

  // The piece holds the second thought and links back.
  await page.goto('/browse');
  await piece.click();
  await expect(note).toContainText('Find a birthday present for Sam');
  await expect(note).toContainText('Split from:');
  await expect(note).toContainText('Drive home ramble');

  // History kept the whole note the split wrote over.
  const id = new URL(originalUrl).pathname.split('/').pop();
  await page.goto(`/history?note=${id}`);
  await expect(
    page
      .getByRole('list', { name: 'Earlier versions' })
      .getByRole('button', { name: /birthday present for Sam/ }),
  ).toBeVisible({ timeout: 30_000 });

  // Put back: the note whole again, the piece archived.
  await page.goto('/activity');
  const changes = page.getByRole('list', { name: 'Changes' });
  await changes.getByRole('button', { name: 'Put back: Split a note into 2' }).click();
  await expect(changes).toContainText('Put back 2 notes?');
  await changes.getByRole('button', { name: 'Yes' }).click();
  await expect(changes).toContainText('Put back 2 notes.');
  await expect(changes).toContainText('Mossgoblin: Put back “Split a note into 2”');
  await page.goto('/browse');
  await expect(original).toBeVisible();
  await expect(piece).toHaveCount(0);
  await original.click();
  await expect(note).toContainText('Order more kiln shelves before the next firing');
  await expect(note).toContainText('Find a birthday present for Sam');
  await expect(note).not.toContainText('Split off:');
});
