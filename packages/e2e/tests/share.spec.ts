import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, openSettings } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Share to Mossgoblin (2026-11-14): the share sheet's words and link
// reach /share (through sw.js, which stamps them with `at`) and are kept
// on the device at once. Words with no link become a note with no tap,
// as before (#42); a link, alone or with words, gets the landing step,
// filed with one tap. A reload never files one twice.

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** The address sw.js opens for a share of these fields. */
function shareUrl(fields: Record<string, string>, at: number): string {
  return `/share?${new URLSearchParams({ ...fields, at: String(at) })}`;
}

test('a link shared alone is kept through a reload, then saved to read later', async ({ page }) => {
  await signInAs(page, OWNER);
  // What Chrome sends for a page: its title, and its address as the text.
  await page.goto(shareUrl({ title: 'Seeds that talk', text: 'https://seeds.invalid/talk' }, 1));
  await expect(
    page.getByRole('heading', { name: 'Shared with Mossgoblin', level: 1 }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/share$/);
  // Kept on the device the moment it came: a reload still has it, once.
  await page.reload();
  const shared = page.getByRole('region', { name: 'What was shared' });
  await expect(shared).toContainText('Seeds that talk');
  await expect(shared.getByRole('link', { name: 'https://seeds.invalid/talk' })).toBeVisible();
  await expect(page.getByText(/more share/)).toHaveCount(0);
  const save = page.getByRole('button', { name: 'Save to read later' });
  await expect(save).toBeFocused();
  await expectNoSeriousViolations(page);

  await save.click();
  await expect(page).toHaveURL(/\/reading$/);
  const queue = page.getByRole('list', { name: 'Reading queue' });
  await expect(queue.getByRole('link', { name: 'https://seeds.invalid/talk' })).toBeVisible();
  await expect(queue.getByRole('listitem')).toHaveCount(1);
});

test('shared words with no link become a note at once, filed once', async ({ page }) => {
  await signInAs(page, OWNER);
  const address = shareUrl({ text: 'what if seeds could talk' }, 2);
  await page.goto(address);
  // No landing step: the note, where a share always landed (#42).
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('textbox', { name: 'New note' })).toContainText(
    'what if seeds could talk',
  );
  await expect(page.getByRole('button', { name: 'Keep as a note' })).toHaveCount(0);
  await letItSave(page);
  await page.reload();
  await expect(page.getByText('A share is waiting to be filed')).toHaveCount(0);

  // The share's own address again (a reload of it before it was tidied).
  await page.goto(address);
  await expect(page.getByText('That share has been filed already.')).toBeVisible();
  await expect(page).toHaveURL(/\/share$/);
  await page.reload();
  await expect(page.getByText('Nothing shared is waiting to be filed.')).toBeVisible();

  await page.goto('/browse');
  const notes = page.getByRole('list', { name: 'Notes' });
  await expect(
    notes.getByRole('listitem').filter({ hasText: 'what if seeds could talk' }),
  ).toHaveCount(1);
});

test('shared words with a link show the landing step, and keep as a note', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto(
    shareUrl({ title: 'Seeds', text: '"seeds could talk"\nhttps://seeds.invalid/talk' }, 4),
  );
  await expect(page).toHaveURL(/\/share$/);
  const shared = page.getByRole('region', { name: 'What was shared' });
  await expect(shared).toContainText('seeds could talk');
  const keep = page.getByRole('button', { name: 'Keep as a note' });
  await expect(keep).toBeFocused();
  // Kitchen is off: no recipe import offered.
  await expect(page.getByRole('button', { name: 'Import as a recipe from this text' })).toHaveCount(
    0,
  );
  await keep.click();
  await expect(page).toHaveURL(/\/$/);
  const note = page.getByRole('textbox', { name: 'New note' });
  await expect(note).toContainText('seeds could talk');
  await expect(note).toContainText('https://seeds.invalid/talk');
  await letItSave(page);
});

test('words shared from a refusing recipe site are imported as the recipe', async ({ page }) => {
  await signInAs(page, OWNER);
  await openSettings(page, 'Modules');
  await page.getByRole('switch', { name: 'Kitchen' }).check();
  await letItSave(page);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Kitchen' })).toBeChecked();

  // Select all on the page and share: the words, then the page's address.
  // refused.invalid answers 402 in the emulator build, and a scripted
  // reader stands in for Claude (kitchen/stand-in.emulator.ts).
  const words = [
    'Hasselback potato gratin',
    'Serves 8',
    'Ingredients',
    '3 pounds russet potatoes',
    '2 cups heavy cream',
    'Method',
    'Slice the potatoes thinly.',
    'Bake until golden.',
  ].join('\n');
  await page.goto(
    shareUrl(
      {
        title: 'Hasselback potato gratin recipe',
        text: `${words}\nhttps://refused.invalid/hasselback-potato-gratin`,
      },
      3,
    ),
  );
  const fromText = page.getByRole('button', { name: 'Import as a recipe from this text' });
  await expect(fromText).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep as a note' })).toBeFocused();
  await expectNoSeriousViolations(page);

  await fromText.click();
  await expect(page).toHaveURL(/\/n\/\w+$/, { timeout: 30_000 });
  const recipe = page.getByRole('region', { name: 'Recipe' });
  await expect(recipe.getByRole('textbox', { name: 'Recipe name' })).toHaveValue(
    'Hasselback potato gratin',
    { timeout: 30_000 },
  );
  await expect(recipe).toContainText('2 ingredients · 2 steps');
  await expect(recipe.getByRole('status')).toHaveCount(0);

  // Filed: nothing waits, and the recipes hold it once.
  await page.goto('/share');
  await expect(page.getByText('Nothing shared is waiting to be filed.')).toBeVisible();
  await page.goto('/browse/recipes');
  await expect(
    page
      .getByRole('list', { name: 'Notes' })
      .getByRole('listitem')
      .filter({ hasText: 'Hasselback potato gratin' }),
  ).toHaveCount(1);
});

test('the share sheet’s post reaches the share page through the service worker', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInAs(page, OWNER);
  // As in share-text.spec.ts: once the worker is registered, a reload
  // puts the page under it, as an installed app always is.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 })
    .toBe(true);

  const landed = await page.evaluate(async () => {
    const form = new FormData();
    form.set('title', 'Moss');
    form.set('text', 'https://moss.invalid/');
    const res = await fetch('/share', { method: 'POST', body: form });
    return res.url;
  });
  expect(landed).toMatch(/\/share\?title=Moss&text=https%3A%2F%2Fmoss\.invalid%2F&at=\d+$/);
  await page.goto(landed);
  await expect(page.getByRole('region', { name: 'What was shared' })).toContainText('Moss');
  await expect(page.getByRole('button', { name: 'Save to read later' })).toBeVisible();

  // A select-all of a long page: too long for an address, so sw.js keeps
  // the words in its cache and the address carries their id (review on
  // #271); they are gone from the cache once the share is filed.
  const long = await page.evaluate(async () => {
    const form = new FormData();
    form.set(
      'text',
      `${'Moss holds water like a sponge. '.repeat(600)}the last line\nhttps://moss.invalid/long`,
    );
    const res = await fetch('/share', { method: 'POST', body: form });
    return res.url;
  });
  expect(long).toMatch(/\/share\?stash=\d+&at=\d+$/);
  await page.goto(long);
  const shared = page.getByRole('region', { name: 'What was shared' });
  await expect(shared).toContainText('Moss holds water like a sponge.');
  await expect(shared).toContainText('more characters');
  await page.getByRole('button', { name: 'Keep as a note' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('textbox', { name: 'New note' })).toContainText('the last line');
  await letItSave(page);
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (await caches.open('mossgoblin-share-words')).keys()).length,
      ),
    )
    .toBe(0);
});
