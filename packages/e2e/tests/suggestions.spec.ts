import AxeBuilder from '@axe-core/playwright';
import { connectClaude } from '../src/claude';
import { expect, letItSave, seedDoc, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Nightly suggestions (#35): the organize run stores proposals; nothing
// changes until Eric accepts one, which works offline, and then the
// matching organize tool runs and What Claude changed records it.

test('accepting a suggestion, even offline, carries it out; dismissing drops it', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Kiln log', 'Cone 6, slow cool.']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Firing notes', 'Shelf 2 cracked.']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();

  // Ids as the nightly run would know them.
  const call = await connectClaude(page);
  const [kiln] = (await call('search_notes', { query: 'cone' })) as { id: string }[];
  const [firing] = (await call('search_notes', { query: 'shelf' })) as { id: string }[];
  const notes = [
    { id: kiln.id, title: 'Kiln log' },
    { id: firing.id, title: 'Firing notes' },
  ];
  const base = { notes, status: 'open', createdAt: new Date() };
  await seedDoc(`users/${OWNER.uid}/proposals/merge`, {
    ...base,
    kind: 'merge',
    reason: 'Both are about the same firing.',
    key: `merge:${[kiln.id, firing.id].sort()}`,
  });
  await seedDoc(`users/${OWNER.uid}/proposals/link`, {
    ...base,
    kind: 'link',
    reason: 'The log mentions the shelf.',
    key: `link:${kiln.id}>${firing.id}`,
  });

  await page.goto('/browse');
  await page.getByRole('link', { name: 'What Claude changed 2 suggestions' }).click();
  await expect(page).toHaveURL(/\/activity$/);
  const suggestions = page.getByRole('list', { name: 'Suggestions' });
  const merge = suggestions.getByRole('listitem').filter({ hasText: 'Merge' });
  const link = suggestions.getByRole('listitem').filter({ hasText: 'Link' });
  await expect(merge).toContainText('Merge Kiln log, Firing notes into one note');
  await expect(merge).toContainText('Both are about the same firing.');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await link.getByRole('button', { name: 'Dismiss' }).click();
  await expect(link).toHaveCount(0);

  // Accepting needs no network; it is carried out once back online.
  await page.context().setOffline(true);
  await merge.getByRole('button', { name: 'Accept' }).click();
  await expect(merge).toContainText('Accepted. Claude is on it.');
  await page.context().setOffline(false);
  await expect(merge).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('list', { name: 'Changes' })).toContainText(
    'Merged 2 notes into one',
  );

  // Nothing waits any more, and the originals are archived.
  await page.goto('/browse/archived');
  await expect(page.getByRole('list', { name: 'Notes' })).toContainText('Firing notes');
  await expect(page.getByRole('link', { name: 'What Claude changed' })).not.toContainText(
    'suggestion',
  );
});
