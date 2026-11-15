import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { FIRESTORE_EMULATOR, expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The gardener's switch (note encryption, 2026-11-15). Turned on in
// Settings after the check, which passes here against the localhost
// stand-ins: the e2e static server's `/api/note-key` and the functions
// emulator's three check callables (`checkNoteKey`,
// `checkNoteKeyTitles`, `checkNoteKeyRunner`, one for each account the
// note-reading functions run as) all derive the owner's key from the
// same development master. From then on the app writes note text sealed: a
// new note is born sealed, an older plain note is sealed by the edit
// that touches it, and Claude still reads both through MCP.

const SEALED = 'mg1.';
const NOTES = `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}`;

type Fields = Record<string, { stringValue?: string; booleanValue?: boolean }>;

/** The owner's notes as the emulator stores them, read as admin. */
async function storedNotes(): Promise<{ id: string; fields: Fields; raw: string }[]> {
  const res = await fetch(`${NOTES}/notes?pageSize=300`, {
    headers: { authorization: 'Bearer owner' },
  });
  const { documents = [] } = (await res.json()) as {
    documents?: { name: string; fields: Fields }[];
  };
  return documents.map((d) => ({
    id: d.name.split('/').pop()!,
    fields: d.fields,
    raw: JSON.stringify(d.fields),
  }));
}

/** The owner's assistant settings, as stored. */
async function storedSetting(): Promise<boolean | undefined> {
  const res = await fetch(`${NOTES}/settings/assistant`, {
    headers: { authorization: 'Bearer owner' },
  });
  const doc = (await res.json()) as { fields?: Fields };
  return doc.fields?.['sealNotes']?.booleanValue;
}

const noteKeyOnDevice = (page: Page) =>
  page.evaluate((uid) => localStorage.getItem(`goblin.noteKey.${uid}`), OWNER.uid);

test('the switch turns sealing on after its check, and notes are then written sealed', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  const editor = page.getByRole('textbox', { name: 'New note' });
  // An older note, written before the switch: plain.
  await typeLines(page, ['Old plain words', 'about the shed']);
  await letItSave(page);
  await expect
    .poll(async () => (await storedNotes()).find((n) => n.raw.includes('Old plain words'))?.id)
    .toBeTruthy();
  const plain = (await storedNotes()).find((n) => n.raw.includes('Old plain words'))!;
  await expect.poll(() => noteKeyOnDevice(page)).not.toBeNull();

  // Settings: what sealing means, the switch off, then the check.
  await page.goto('/settings');
  const section = page.getByRole('heading', { name: 'Sealed notes' });
  await section.scrollIntoViewIfNeeded();
  await expect(page.getByText('Sealing encrypts the text of your notes')).toBeVisible();
  const toggle = page.getByRole('switch', { name: 'Seal note text' });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#sealing-status')).toHaveText(
    'Sealing is off: notes are stored as they are now.',
  );
  await toggle.click();
  await expect(page.locator('#sealing-status')).toContainText(
    'This device and every part of the server got the same key',
  );
  await expect(toggle).toBeChecked();
  await expect.poll(storedSetting).toBe(true);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
  ).toEqual([]);

  // A new note: born sealed, body and title, its words nowhere in the clear.
  await page.goto('/');
  await page.getByRole('button', { name: 'New' }).click();
  await editor.click();
  await typeLines(page, ['Kiln firing tonight', 'Cone 6, slow cool']);
  await letItSave(page);
  const isBorn = (n: { id: string; fields: Fields }) =>
    n.id !== plain.id && n.id !== 'context' && !!n.fields['body']?.stringValue?.startsWith(SEALED);
  await expect.poll(async () => (await storedNotes()).some(isBorn)).toBe(true);
  const born = (await storedNotes()).find(isBorn);
  expect(born).toBeDefined();
  expect(born!.fields['title']?.stringValue?.startsWith(SEALED)).toBe(true);
  for (const n of await storedNotes()) {
    expect(n.raw).not.toContain('Kiln');
    expect(n.raw).not.toContain('Cone 6');
  }

  // Reloaded, it opens with the key.
  await page.reload();
  await page.goto('/browse');
  const list = page.getByRole('list', { name: 'Notes' });
  await list.getByRole('link', { name: /Kiln firing tonight/ }).click();
  await expect(editor).toContainText('Cone 6, slow cool');
  await expect(page.locator('body')).not.toContainText('');

  // The older plain note, edited: the edit writes it sealed.
  await page.goto('/browse');
  await list.getByRole('link', { name: /Old plain words/ }).click();
  await expect(editor).toContainText('about the shed');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(', mended');
  await letItSave(page);
  await expect
    .poll(async () =>
      (await storedNotes())
        .find((n) => n.id === plain.id)
        ?.fields['body']?.stringValue?.startsWith(SEALED),
    )
    .toBe(true);
  const edited = (await storedNotes()).find((n) => n.id === plain.id)!;
  expect(edited.fields['title']?.stringValue?.startsWith(SEALED)).toBe(true);
  expect(edited.raw).not.toContain('Old plain words');
  expect(edited.raw).not.toContain('mended');
  await page.reload();
  await expect(editor).toContainText('about the shed, mended');

  // Claude reads both through MCP, opened by the functions' own key.
  const call = await connectClaude(page);
  const fromBirth = (await call('get_note', { id: born!.id })) as { body: string; title: string };
  expect(fromBirth.body).toBe('Kiln firing tonight\nCone 6, slow cool');
  expect(fromBirth.title).not.toContain('\uE000');
  const mended = (await call('get_note', { id: plain.id })) as { body: string };
  expect(mended.body).toBe('Old plain words\nabout the shed, mended');
});
