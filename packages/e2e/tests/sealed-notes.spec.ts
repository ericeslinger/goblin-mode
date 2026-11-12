import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { DEV_NOTE_KEYS_MASTER } from '../../functions/src/note-keys/dev-master.emulator';
import { deriveNoteKey, masterFromBase64 } from '../../schema/src/note-key';
import { aadFor, importDataKey, sealText } from '../../schema/src/sealed';
import { FIRESTORE_EMULATOR, expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Note encryption step 3a (2026-11-12): the app reads sealed notes. A
// note sealed with the owner's development key, as the e2e static
// server's `/api/note-key` derives it, is put straight into the
// emulator; the app opens it with the key, and without one shows it
// locked and never writes over it.

const SEALED_ID = 'SealedJourneyNote001';
const BODY = 'Kiln firing\nCone 6, slow cool over the night';
const TITLE = 'Kiln firing';
const DOC = `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/notes/${SEALED_ID}`;

/** The owner's data key, derived from the development master. */
async function ownerKey() {
  const master = masterFromBase64(DEV_NOTE_KEYS_MASTER);
  if (!master) throw new Error('no development master');
  return importDataKey(await deriveNoteKey(master, OWNER.uid, 1));
}

/** Writes the sealed note past the rules, as admin; returns what it stored. */
async function seedSealedNote(): Promise<{ body: string; title: string }> {
  const key = await ownerKey();
  const body = sealText(key, aadFor(OWNER.uid, SEALED_ID, 'body'), BODY);
  const title = sealText(key, aadFor(OWNER.uid, SEALED_ID, 'title'), TITLE);
  const now = new Date().toISOString();
  const res = await fetch(DOC, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        body: { stringValue: body },
        title: { stringValue: title },
        titleSource: { stringValue: 'user' },
        kind: { stringValue: 'text' },
        links: { arrayValue: {} },
        tags: { arrayValue: {} },
        archived: { booleanValue: false },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
        updatedBy: { stringValue: 'user' },
        deviceId: { stringValue: 'seed' },
      },
    }),
  });
  if (!res.ok) throw new Error(`could not seed the sealed note: ${await res.text()}`);
  return { body, title };
}

/** The sealed note's body and title as stored, read as admin. */
async function storedSealedNote(): Promise<{ body?: string; title?: string }> {
  const res = await fetch(DOC, { headers: { authorization: 'Bearer owner' } });
  const doc = (await res.json()) as {
    fields?: { body?: { stringValue: string }; title?: { stringValue: string } };
  };
  return { body: doc.fields?.body?.stringValue, title: doc.fields?.title?.stringValue };
}

/** The whole stored document as the emulator has it: every field, and when it was last written. */
async function storedDocument(): Promise<unknown> {
  const res = await fetch(DOC, { headers: { authorization: 'Bearer owner' } });
  const { fields, updateTime } = (await res.json()) as { fields?: unknown; updateTime?: string };
  return { fields, updateTime };
}

const noteKeyOnDevice = (page: Page) =>
  page.evaluate((uid) => localStorage.getItem(`goblin.noteKey.${uid}`), OWNER.uid);

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

test('a sealed note opens with the key, and without it shows as sealed, untouched', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  const editor = page.getByRole('textbox', { name: 'New note' });
  await typeLines(page, ['Plain words stay plain']);
  await letItSave(page);
  await expect.poll(() => noteKeyOnDevice(page)).not.toBeNull();
  const seeded = await seedSealedNote();

  // With the key: its real title in the list, its real text when opened.
  await page.goto('/browse');
  const list = page.getByRole('list', { name: 'Notes' });
  await list.getByRole('link', { name: /Kiln firing/ }).click();
  await expect(editor).toContainText('Cone 6, slow cool over the night');
  await expect(page.locator('body')).not.toContainText('\uE000');

  // The key leaves the device, and the service cannot give it again.
  // Routed on the context, which also sees the service worker's requests.
  await page
    .context()
    .route('**/api/note-key', (route) => route.fulfill({ status: 503, body: '' }));
  await page.evaluate((uid) => localStorage.removeItem(`goblin.noteKey.${uid}`), OWNER.uid);
  // As it stands now, with the key gone: nothing may write to it from here on.
  await letItSave(page);
  const whileLocked = await storedDocument();
  await page.goto('/browse');
  await expect(list.getByRole('link', { name: 'Sealed note' })).toBeVisible();
  await expect(list.getByRole('link', { name: /Kiln firing/ })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('\uE000');
  await expectNoSeriousViolations(page);

  // Opened: one calm line, no editor, no sealed text.
  await list.getByRole('link', { name: 'Sealed note' }).click();
  await expect(
    page.getByText('This note is sealed, and its key is not on this device yet.'),
  ).toBeVisible();
  await expect(editor).toBeHidden();
  await expect(page.locator('body')).not.toContainText('\uE000');
  await expectNoSeriousViolations(page);

  // Plain notes work as ever beside it.
  await page.goto('/browse');
  await list.getByRole('link', { name: /Plain words stay plain/ }).click();
  await expect(editor).toContainText('Plain words stay plain');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(', still');
  await letItSave(page);
  await page.reload();
  await expect(editor).toContainText('Plain words stay plain, still');

  // Nothing was written over the sealed note: its text as seeded, and
  // not one field or write time changed while it was locked (review
  // on #262).
  expect(await storedSealedNote()).toEqual(seeded);
  expect(await storedDocument()).toEqual(whileLocked);
});
