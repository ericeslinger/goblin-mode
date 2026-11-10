import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// What assistants changed (#34): Claude organizes through MCP, and the app
// lists each change with the notes it touched and their History. Put back
// (#154 step 1) undoes a change in one tap, as a run of its own, filing
// included (#206). After a filing is put back, File it under… files the
// note under the project Eric picks, as a change of his own (#235).

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('a merge by Claude shows in What assistants changed, with its notes and History, and is put back', async ({
  page,
}) => {
  // It now puts back two changes too (#154).
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  await typeLines(page, ['Kiln log', 'Cone 6, slow cool.']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Firing notes', 'Shelf 2 cracked.']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();

  const call = await connectClaude(page);
  const listed = (await call('search_notes', { query: 'kiln' })) as { id: string }[];
  const [kiln] = listed;
  const [firing] = (await call('search_notes', { query: 'shelf' })) as { id: string }[];
  const merged = (await call('merge_notes', { ids: [kiln.id, firing.id] })) as { id: string };

  await page.goto('/browse');
  await page.getByRole('link', { name: 'What assistants changed' }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole('heading', { name: 'What assistants changed' })).toBeVisible();
  const touched = page.getByRole('list', { name: 'Notes: Merged 2 notes into one' });
  await expect(touched.getByRole('link', { name: 'Firing notes', exact: true })).toBeVisible();
  await expect(touched).toContainText('archived');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // The merged note holds both, word for word.
  await touched.getByRole('link', { name: 'Kiln log', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/n/${merged.id}$`));
  await expect(note(page)).toContainText('Cone 6, slow cool.');
  await expect(note(page)).toContainText('Shelf 2 cracked.');
  await page.goBack();

  // An original's History is a tap away.
  await touched.getByRole('link', { name: 'History of Firing notes' }).click();
  await expect(page).toHaveURL(new RegExp(`/history\\?note=${firing.id}$`));
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();

  // Put back the merge: the originals come back, the merged note is
  // archived, and the put back shows as a change of its own.
  await page.goto('/activity');
  const changes = page.getByRole('list', { name: 'Changes' });
  await changes.getByRole('button', { name: 'Put back: Merged 2 notes into one' }).click();
  await expect(changes).toContainText('Put back 3 notes?');
  await changes.getByRole('button', { name: 'Yes' }).click();
  await expect(changes).toContainText('Put back 3 notes.');
  await expect(changes).toContainText('Mossgoblin: Put back “Merged 2 notes into one”');
  await expect(touched.getByRole('listitem').filter({ hasText: 'Firing notes' })).not.toContainText(
    'archived',
  );
  await expect(
    touched
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: 'History of Kiln log' }) })
      .first(),
  ).toContainText('archived');
  // The put back can itself be put back; the merge cannot be twice.
  await expect(
    changes.getByRole('button', { name: 'Put back: Put back “Merged 2 notes into one”' }),
  ).toBeVisible();
  await expect(
    changes.getByRole('button', { name: 'Put back: Merged 2 notes into one' }),
  ).toHaveCount(0);

  // Claude adds a line to a note; putting that back leaves the text as
  // Eric wrote it.
  await call('add_lines', { id: firing.id, lines: ['- [ ] order a new shelf'] });
  // noteHistory runs in the emulator: wait until it kept the text it replaced.
  await page.goto(`/history?note=${firing.id}`);
  await expect(
    page
      .getByRole('list', { name: 'Earlier versions' })
      .getByRole('button', { name: /Shelf 2 cracked/ }),
  ).toBeVisible();
  await page.goto('/activity');
  await changes.getByRole('button', { name: 'Put back: Added 1 line to Firing notes' }).click();
  await expect(changes).toContainText('Put back 1 note?');
  await changes.getByRole('button', { name: 'Yes' }).click();
  await expect(changes).toContainText('Put back 1 note.');
  await expect(changes).toContainText('Mossgoblin: Put back “Added 1 line to Firing notes”');
  await page.goto(`/n/${firing.id}`);
  await expect(note(page)).toContainText('Shelf 2 cracked.');
  await expect(note(page)).not.toContainText('order a new shelf');

  // Claude tags the note; putting that back takes the tag off (#206).
  await call('refile', { id: firing.id, addTags: ['kiln'] });
  const back = page.getByRole('region', { name: 'Back of the note' });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(back.getByRole('list', { name: 'Tags' })).toContainText('kiln');
  await page.goto('/activity');
  await changes
    .getByRole('button', { name: 'Put back: Refiled Firing notes: tagged kiln' })
    .click();
  await expect(changes).toContainText('Put back 1 note?');
  await changes.getByRole('button', { name: 'Yes' }).click();
  await expect(changes).toContainText('Put back 1 note.');
  await expect(changes).toContainText('Mossgoblin: Put back “Refiled Firing notes: tagged kiln”');
  await page.goto(`/n/${firing.id}`);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(back).toBeVisible();
  await expect(back.getByRole('list', { name: 'Tags' })).toHaveCount(0);
});

test('after a filing is put back, File it under… files the note under another project', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  await typeLines(page, ['Kiln log', 'Cone 6, slow cool.']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();

  const call = await connectClaude(page);
  await call('create_concept', { name: 'Pottery', type: 'project' });
  await call('create_concept', { name: 'Garden', type: 'project' });
  const [kiln] = (await call('search_notes', { query: 'kiln' })) as { id: string }[];
  // The assistant files the note under the wrong project.
  await call('link_notes', { from: kiln.id, to: ['c-pottery'] });
  // noteHistory runs in the emulator: wait until it kept the text it replaced.
  await page.goto(`/history?note=${kiln.id}`);
  await expect(
    page.getByRole('list', { name: 'Earlier versions' }).getByRole('button', { name: /slow cool/ }),
  ).toBeVisible({ timeout: 15_000 });

  await page.goto('/activity');
  const changes = page.getByRole('list', { name: 'Changes' });
  await changes.getByRole('button', { name: 'Put back: Linked a note to 1 other' }).click();
  await changes.getByRole('button', { name: 'Yes' }).click();
  await expect(changes).toContainText('Put back 1 note.', { timeout: 15_000 });

  // One more tap files it where Eric meant.
  const offer = changes.getByRole('group', { name: 'File it under: Linked a note to 1 other' });
  await expect(offer).toContainText('File it under…');
  await expect(offer.getByRole('button', { name: 'Pottery' })).toBeVisible();
  await offer.getByRole('button', { name: 'Garden' }).click();
  await expect(changes).toContainText('Filed under Garden.', { timeout: 15_000 });
  await expect(offer).toHaveCount(0);
  await expect(changes).toContainText('Mossgoblin: Filed Kiln log under Garden');
  // His own change, listed like any other, can itself be put back.
  await expect(
    changes.getByRole('button', { name: 'Put back: Filed Kiln log under Garden' }),
  ).toBeVisible();

  // His text stays word for word, with the link under it.
  await page.goto(`/n/${kiln.id}`);
  await expect(note(page)).toContainText('Cone 6, slow cool.');
  await expect(note(page)).toContainText('Garden');
  await expect(note(page)).not.toContainText('Pottery');

  // The note shows under Garden.
  await page.goto('/n/c-garden');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const back = page.getByRole('region', { name: 'Back of the note' });
  await expect(
    back
      .getByRole('region', { name: 'Linked from' })
      .getByRole('link', { name: 'Kiln log', exact: true }),
  ).toBeVisible({ timeout: 15_000 });
});
