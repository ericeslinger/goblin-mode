import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { connectClaude } from '../src/claude';
import {
  FIRESTORE_EMULATOR,
  expect,
  letItSave,
  openMore,
  signInAs,
  test,
  typeLines,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// Seal everything now (note encryption, the migration, Eric,
// 2026-11-15). A garden written before the switch, all plain: a note
// with History, a concept with other names, a suggestion, a finished
// item run and entries in What assistants changed. The switch goes on,
// Settings counts what is not sealed (a dry run, nothing written), then
// on a second tap the `sealEverything` callable seals it, in the
// functions emulator with the stand-in key. Afterwards no word of the
// garden is in the clear in the emulator's notes, versions,
// suggestions, runs or activity (replaced texts are left to expire, so
// they are not read here); the note still reads in the app and in its
// History, and Claude reads it through MCP.
//
// A concept's id is made from its name (`c-gooseberry`) and is not
// sealed: ids are not text (DESIGN.md, What is left plain). The words
// checked below are written as they are in the text, capitalised, so
// an id does not count.

const DOCS = `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents`;
const MINE = `${DOCS}/users/${OWNER.uid}`;
const ADMIN = { authorization: 'Bearer owner' };

/** Every document of the owner's in collections named `id`, at any depth, as admin. */
async function everyDoc(id: string): Promise<{ name: string; fields: Record<string, unknown> }[]> {
  const res = await fetch(`${MINE}:runQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ADMIN },
    body: JSON.stringify({
      structuredQuery: { from: [{ collectionId: id, allDescendants: true }] },
    }),
  });
  const rows = (await res.json()) as {
    document?: { name: string; fields: Record<string, unknown> };
  }[];
  return rows.flatMap((r) => (r.document ? [r.document] : []));
}

/** What is checked for plain text: everything sealed or relabelled, but replaced texts. */
async function storedText(): Promise<string> {
  const kinds = await Promise.all(
    ['notes', 'history', 'proposals', 'runs', 'activity'].map(everyDoc),
  );
  return JSON.stringify(kinds.flat().map((d) => d.fields));
}

const WORDS = [
  'Rhubarb',
  'crumble',
  'oats',
  'Gooseberry',
  'Ribes',
  'grower',
  'Ely',
  'pairs with',
  'Wineberry',
  'wineberry',
];

const ITEM = 'find a rhubarb grower';

test('seal everything now: counts, then seals what the switch left plain', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAs(page, OWNER);
  const editor = page.getByRole('textbox', { name: 'New note' });
  await typeLines(page, ['Rhubarb crumble plan', 'buy oats']);
  await letItSave(page);

  // Claude, before the switch: a line added (History keeps the text it
  // wrote over), a concept and its other names, a note with a done
  // item, and a suggestion.
  const call = await connectClaude(page);
  const [crumble] = (await call('search_notes', { query: 'oats' })) as { id: string }[];
  await call('add_lines', { id: crumble.id, lines: ['- Rhubarb from the allotment'] });
  const concept = (await call('create_concept', { name: 'Gooseberry' })) as { id: string };
  await call('refile', { id: concept.id, addSynonyms: ['Ribes'] });
  const jobs = (await call('create_note', {
    body: `Garden jobs\n- [x] ${ITEM} @goblin`,
  })) as { id: string };
  await call('suggest_changes', {
    proposals: [
      {
        kind: 'link',
        from: crumble.id,
        to: [concept.id],
        reason: 'Rhubarb pairs with Gooseberry in a crumble.',
      },
      { kind: 'refile', id: concept.id, synonyms: ['Wineberry'], reason: 'Another name for it.' },
    ],
  });
  // A finished item run, under the id a plain note's run had: the plain
  // hash of its item.
  const plainRun = `item-${jobs.id}-${createHash('sha256').update(ITEM).digest('hex').slice(0, 16)}`;
  const seeded = await fetch(`${MINE}/runs/${plainRun}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...ADMIN },
    body: JSON.stringify({
      fields: {
        kind: { stringValue: 'item' },
        noteId: { stringValue: jobs.id },
        itemText: { stringValue: ITEM },
        itemKey: { stringValue: ITEM },
        status: { stringValue: 'done' },
        outcome: { stringValue: 'Found a Rhubarb grower near Ely' },
        attempt: { integerValue: '1' },
        steps: { arrayValue: { values: [] } },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  expect(seeded.ok).toBe(true);
  // History holds the text Claude's line was added over, plain.
  await expect
    .poll(async () => (await everyDoc('history')).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const before = await storedText();
  for (const w of WORDS) expect(before, w).toContain(w);

  // The switch, then the action that shows once it is on.
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Seal note text' }).click();
  await expect(page.locator('#sealing-status')).toContainText('got the same key');
  const start = page.getByRole('button', { name: 'Seal everything now' });
  await start.scrollIntoViewIfNeeded();
  await start.click();
  const counted = page.getByRole('list', { name: 'What sealing everything would do' });
  await expect(counted).toContainText('Not sealed yet:', { timeout: 30_000 });
  await expect(page.locator('#seal-everything-progress')).toHaveText(
    'Counted. Nothing has been changed.',
  );
  await expect(page.getByText('open Mossgoblin on your other devices')).toBeVisible();
  // The dry run wrote nothing.
  for (const w of WORDS) expect(await storedText(), w).toContain(w);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
  ).toEqual([]);

  await page.getByRole('button', { name: 'Seal them now' }).click();
  await expect(page.locator('#seal-everything-progress')).toHaveText('Finished.', {
    timeout: 120_000,
  });
  const did = page.getByRole('list', { name: 'What sealing everything did' });
  await expect(did).toContainText('Sealed ');
  await expect(did).toContainText('Relabelled ');
  await expect(did).toContainText('nothing left in the clear');

  // Nothing of the garden is in the clear any more.
  const after = await storedText();
  for (const w of WORDS) expect(after, w).not.toContain(w);
  // The item run moved to an id with no plain hash of its item in it.
  const runs = (await everyDoc('runs')).map((d) => d.name.split('/').pop()!);
  expect(runs).not.toContain(plainRun);
  expect(runs.some((id) => id.startsWith(`item-${jobs.id}-k1.`))).toBe(true);
  // The refile suggestion keeps its proposed name, sealed, and its key
  // holds a keyed hash of it, as a new one's does.
  const refile = (await everyDoc('proposals')).find((d) =>
    JSON.stringify(d.fields).includes('"refile"'),
  )!;
  expect(JSON.stringify(refile.fields['key'])).toMatch(/refile:[^:]+::k1\./);
  expect(JSON.stringify(refile.fields['synonyms'])).toContain('mg1.');
  // What assistants changed is relabelled, not emptied.
  const activity = await everyDoc('activity');
  expect(activity.length).toBeGreaterThan(2);
  expect(JSON.stringify(activity)).toContain('Sealed note');

  // Reloaded, the note reads as before, and so does its History.
  await page.goto('/browse');
  await page.reload();
  await page
    .getByRole('list', { name: 'Notes' })
    .getByRole('link', { name: /Rhubarb crumble plan/ })
    .click();
  await expect(editor).toContainText('Rhubarb from the allotment');
  await (await openMore(page)).getByRole('link', { name: 'History' }).click();
  await expect(
    page.getByRole('list', { name: 'Earlier versions' }).getByRole('button', { name: /buy oats/ }),
  ).toBeVisible();

  // Claude reads it through MCP, opened by the functions' own key.
  const read = (await call('get_note', { id: crumble.id })) as { body: string; title: string };
  expect(read.body).toContain('buy oats');
  expect(read.body).toContain('Rhubarb from the allotment');
  expect(read.title).not.toContain('');
  const named = (await call('get_note', { id: concept.id })) as { title: string };
  expect(named.title).toBe('Gooseberry');
});
