import { type Page, devices } from '@playwright/test';
import { expect, letItSave, prepPage, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

// noteHistory runs in the e2e functions emulator, so a write from a
// second device keeps the first device's version for real.
test('a version another device wrote over can be found in History and restored', async ({
  page,
  browser,
}) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Groceries: milk, eggs']);
  await letItSave(page);

  const other = await browser.newContext({ ...devices['Pixel 7'] });
  const second = await other.newPage();
  await prepPage(second);
  await signInAs(second, OWNER, { reset: false });
  await second.goto('/browse');
  await second
    .getByRole('list', { name: 'Notes' })
    .getByRole('link', { name: /Groceries/ })
    .click();
  await expect(note(second)).toContainText('Groceries: milk, eggs');
  await note(second).click();
  await second.keyboard.press('ControlOrMeta+a');
  await second.keyboard.type('Groceries: oat milk');
  await letItSave(second);
  await other.close();

  await page.reload();
  await expect(note(page)).toContainText('Groceries: oat milk');
  await page.getByRole('link', { name: 'History' }).click();
  const versions = page.getByRole('list', { name: 'Earlier versions' });
  const kept = versions.getByRole('button', { name: /Groceries: milk, eggs/ });
  await expect(kept).toContainText('Written over from another device');
  await kept.click();
  await page.getByRole('button', { name: 'Restore this version' }).click();

  await expect(note(page)).toHaveText('Groceries: milk, eggs');
  await letItSave(page);
  await page.reload();
  await expect(note(page)).toHaveText('Groceries: milk, eggs');
  // The text the restore replaced is kept in turn.
  await page.getByRole('link', { name: 'History' }).click();
  await expect(
    page.getByRole('list', { name: 'Earlier versions' }).getByRole('button', { name: /oat milk/ }),
  ).toBeVisible();
});

const FIRESTORE = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';

/** Every note in the emulator with its body and settledAt, read as admin. */
async function storedNotes(): Promise<{ body: string; settled: boolean }[]> {
  const res = await fetch(
    `http://${FIRESTORE}/v1/projects/demo-goblin-mode/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({
        structuredQuery: { from: [{ collectionId: 'notes', allDescendants: true }] },
      }),
    },
  );
  const rows = (await res.json()) as {
    document?: { fields: { body?: { stringValue: string }; settledAt?: unknown } };
  }[];
  return rows.flatMap((r) =>
    r.document
      ? [
          {
            body: r.document.fields.body?.stringValue ?? '',
            settled: !!r.document.fields.settledAt,
          },
        ]
      : [],
  );
}

test('leaving a note settles it, which is what asks for a Claude title', async ({ page }) => {
  await fetch(
    `http://${FIRESTORE}/emulator/v1/projects/demo-goblin-mode/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  await signInAs(page, OWNER);
  await typeLines(page, ['Ask the bank about loan rates']);
  await letItSave(page);
  await expect
    .poll(storedNotes)
    .toEqual([{ body: 'Ask the bank about loan rates', settled: false }]);

  await page.getByRole('button', { name: 'New' }).click();
  await expect
    .poll(storedNotes)
    .toEqual([{ body: 'Ask the bank about loan rates', settled: true }]);
});
