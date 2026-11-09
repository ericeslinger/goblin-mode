import AxeBuilder from '@axe-core/playwright';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Browse lenses (#31): Recent, Concepts, People, Projects, Tags,
// Archived and Trash (#217), each with a count and its own URL.

test('lenses sort the garden, each at its own URL', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Studio day', 'Ask [[Vikas]] about the [[Kiln]].', 'clay']);
  await letItSave(page);
  // Leaving the note makes the two concepts.
  await page.getByRole('button', { name: 'New' }).click();

  await page.goto('/browse/concepts');
  const notes = page.getByRole('list', { name: 'Notes' });
  await expect(notes).toContainText('Vikas');
  await expect(notes).toContainText('Linked from 1 note');
  await expect(notes).not.toContainText('Studio day');

  // Make Vikas a person; the People lens and its count follow.
  await notes.getByRole('link', { name: /Vikas/ }).click();
  await page.getByRole('combobox', { name: 'Type' }).selectOption('person');
  await page.goBack();
  await expect(page).toHaveURL(/\/browse\/concepts$/);

  const lenses = page.getByRole('navigation', { name: 'Lenses' });
  await lenses.getByRole('link', { name: /^People/ }).click();
  await expect(page).toHaveURL(/\/browse\/people$/);
  await expect(lenses.getByRole('link', { name: /^People/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(lenses.getByRole('link', { name: /^People/ })).toContainText('1');
  await expect(notes).toContainText('Vikas');
  await expect(notes).not.toContainText('Kiln');

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await lenses.getByRole('link', { name: /^Recent/ }).click();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(notes).toContainText('Studio day');
  await page.goBack();
  await expect(page).toHaveURL(/\/browse\/people$/);
});

// Trash (#217): Delete on a note's back, after a one-line confirm, puts
// it in Trash for 30 days; it leaves Recent and Archived, and Restore
// brings it back.
test('a note deleted from its back waits in Trash, and comes back', async ({ page }) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  const { id } = (await call('create_note', { body: 'Glaze notes\nCeladon over the bisque' })) as {
    id: string;
  };
  await page.goto(`/n/${id}`);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const back = page.getByRole('region', { name: 'Back of the note' });
  await back.getByRole('button', { name: 'Delete' }).click();
  await expect(back).toContainText('Delete this note? It stays in Trash for 30 days.');
  await back.getByRole('button', { name: 'Yes' }).click();
  // The page leaves the deleted note for a fresh one.
  await expect(page).toHaveURL(/\/$/);
  await letItSave(page);
  await expect
    .poll(
      () =>
        call('get_note', { id }).then(
          () => 'there',
          (err: Error) => err.message,
        ),
      { timeout: 15_000 },
    )
    .toMatch(/in Trash/);

  const notes = page.getByRole('list', { name: 'Notes' });
  await page.goto('/browse');
  await expect(page.getByRole('main')).not.toContainText('Glaze notes');
  await page.goto('/browse/archived');
  await expect(page.getByRole('main')).not.toContainText('Glaze notes');
  const lenses = page.getByRole('navigation', { name: 'Lenses' });
  await lenses.getByRole('link', { name: /^Trash/ }).click();
  await expect(page).toHaveURL(/\/browse\/trash$/);
  await expect(lenses.getByRole('link', { name: /^Trash/ })).toContainText('1');
  await expect(notes).toContainText('Glaze notes');
  await expect(notes).toContainText('Gone in 30 days');

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await notes.getByRole('button', { name: 'Restore: Glaze notes' }).click();
  await expect(page.getByRole('main')).toContainText('Nothing in Trash.');
  await letItSave(page);
  await expect
    .poll(async () => ((await call('get_note', { id })) as { title: string }).title, {
      timeout: 15_000,
    })
    .toBe('Glaze notes');
  await page.goto('/browse');
  await expect(notes).toContainText('Glaze notes');
});
