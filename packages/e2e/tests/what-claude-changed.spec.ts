import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// What assistants changed (#34): Claude organizes through MCP, and the app
// lists each change with the notes it touched and their History. Put back
// (#154 step 1) undoes a change in one tap, as a run of its own, filing
// included (#206). After a filing is put back, File it under… files the
// note under the project Eric picks, as a change of his own (#235). Each
// correction leaves a line under Corrections in Context for Claude, which
// the next run reads (#239). Show changes opens the text before a change
// and after it, the changed lines marked (#241).

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

  // Both corrections are noted in Context for Claude, under a heading of
  // their own, for the next run to read (#239).
  const day = /\(\d{4}-\d{2}-\d{2}\)\./;
  const putBackLine = 'Put back: Linked Kiln log to Pottery';
  const rerouteLine = 'Filed Kiln log under Garden, not Pottery';
  await page.goto('/n/context');
  await expect(note(page)).toContainText('Corrections', { timeout: 15_000 });
  await expect(note(page)).toContainText(putBackLine);
  await expect(note(page)).toContainText(rerouteLine);
  const { text } = (await call('get_context', {})) as { text: string };
  const lines = text.split('\n');
  const heading = lines.indexOf('## Corrections');
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(lines.slice(heading + 1, heading + 3)).toEqual([
    expect.stringMatching(new RegExp(`^- ${putBackLine} ${day.source}$`)),
    expect.stringMatching(new RegExp(`^- ${rerouteLine} ${day.source}$`)),
  ]);
});

// The daily digest (#237, step 4 of #154): the top of What assistants
// changed says yesterday in one line. A journey's records are all
// today's, and the line says today so far when yesterday had nothing,
// so that is what it checks; the push's switch and hour are kept in
// Settings.
test('the day in one line tops What assistants changed, and the digest push is kept', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Kiln log', 'Cone 6, slow cool.']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();

  const call = await connectClaude(page);
  const [kiln] = (await call('search_notes', { query: 'kiln' })) as { id: string }[];
  await call('add_lines', { id: kiln.id, lines: ['Cone 6 again.', 'Shelf 3 held.'] });
  await call('create_note', { title: 'Gift ideas', body: 'A kiln shelf for Sam.' });

  await page.goto('/activity');
  const digest = page.getByRole('region', { name: 'The day in one line' });
  await expect(digest).toContainText('Today so far: 2 lines added to Kiln log, Gift ideas made.');
  await expect(page.getByRole('list', { name: 'Changes' })).toContainText(
    'Added 2 lines to Kiln log',
  );

  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: 'A daily digest by push' });
  const hour = page.getByRole('combobox', { name: 'Hour of the daily digest' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await hour.selectOption('21');
  await expect(toggle).toBeChecked();
  await letItSave(page);
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(hour).toHaveValue('21');
});

test('Show changes opens the before and after of a note a change wrote, added lines marked', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signInAs(page, OWNER);
  await typeLines(page, ['Glaze tests', 'Celadon on porcelain.']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();

  const call = await connectClaude(page);
  const [glaze] = (await call('search_notes', { query: 'celadon' })) as { id: string }[];
  await call('add_lines', { id: glaze.id, lines: ['- tenmoku next', '- shino after'] });
  // noteHistory runs in the emulator: wait until it kept the text it replaced.
  await page.goto(`/history?note=${glaze.id}`);
  await expect(
    page.getByRole('list', { name: 'Earlier versions' }).getByRole('button', { name: /Celadon/ }),
  ).toBeVisible({ timeout: 15_000 });

  await page.goto('/activity');
  const changes = page.getByRole('list', { name: 'Changes' });
  const show = changes.getByRole('button', { name: 'Show changes: Glaze tests' });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  await expect(show).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByRole('region', { name: 'Changes to Glaze tests' });
  const before = panel.getByRole('group', { name: 'Before' });
  const after = panel.getByRole('group', { name: 'After' });
  // The added lines are marked added, in words as well as colour; his
  // line is kept on both sides.
  await expect(after.locator('ins')).toHaveText([
    '+Added: - tenmoku next',
    '+Added: - shino after',
  ]);
  await expect(after).toContainText('The note now');
  await expect(after).toContainText('Celadon on porcelain.');
  await expect(before).toContainText('Kept in History');
  await expect(before).toContainText('Celadon on porcelain.');
  await expect(before).not.toContainText('tenmoku');
  await expect(panel.locator('del')).toHaveCount(0);

  // On a phone the two sides stack, before above after.
  const top = await before.boundingBox();
  const below = await after.boundingBox();
  expect(top && below && below.y >= top.y + top.height).toBe(true);

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // It only reads: closing it changes nothing.
  await show.click();
  await expect(panel).toHaveCount(0);
  await page.goto(`/n/${glaze.id}`);
  // The live preview draws the list marker as a bullet.
  await expect(note(page)).toContainText('shino after');
});
