import type { Browser, Page } from '@playwright/test';
import { expect, letItSave, openSettings, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// A note's public copy (2026-11-26, Eric; DESIGN.md, Sharing a public
// copy): shared from the back of the note, read at /s/<id> by anyone
// with the link and no sign-in, a snapshot until Update the shared copy,
// gone at Stop sharing, and a new link when shared again. The page is
// the Worker's own code, served here by the e2e static server over
// this stack's Firestore emulator (scripts/serve-static.mjs).

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

/** The page at `link` in a browser context of its own: never signed in, no service worker. */
async function openAsStranger(browser: Browser, link: string) {
  const context = await browser.newContext();
  const stranger = await context.newPage();
  // What the page's policy refused, as Chrome says it in the console.
  const refused: string[] = [];
  stranger.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) refused.push(m.text());
  });
  const res = await stranger.goto(link);
  return { context, stranger, res: res!, refused };
}

/** The share's link, as the back of the note shows it. */
async function sharedLink(page: Page): Promise<string> {
  const link = page.getByRole('link', { name: 'The shared link' });
  await expect(link).toBeVisible();
  return (await link.getAttribute('href'))!;
}

test('a note is shared as a public copy, updated when asked, stopped, and shared anew', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signInAs(page, OWNER);
  await note(page).click();
  await typeLines(page, [
    'Glaze for the big jar',
    'Two parts *feldspar*, one of [[Silica]] #pottery',
    '- [ ] buy cones @goblin',
  ]);
  await letItSave(page);

  // On the back: what is about the note, which the copy never carries.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const instructions = page.getByRole('textbox', { name: 'Instructions for Claude' });
  await instructions.fill('Keep this private: file under kiln.');
  await instructions.blur();
  await expect(page.getByText('A public copy of the title and text')).toBeVisible();
  const title = (await page.locator('app-note-back h2.title').textContent())!.trim();
  expect(title).toBeTruthy();
  await page.getByRole('button', { name: 'Share a copy' }).click();
  await expect(page.getByText('Anyone with the link can read this copy')).toBeVisible();
  await expect(page.getByText('It is not listed anywhere.')).toBeVisible();
  const link = await sharedLink(page);
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{32}$/);
  await letItSave(page);

  // A stranger reads the title and text, and nothing from the back.
  const first = await openAsStranger(browser, link);
  expect(first.res.status()).toBe(200);
  const headers = first.res.headers();
  expect(headers['content-security-policy']).toContain("default-src 'none'");
  expect(headers['x-robots-tag']).toBe('noindex, nofollow');
  expect(headers['cache-control']).toBe('private, no-store');
  const s = first.stranger;
  await expect(s.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(s.locator('main')).toContainText('Two parts feldspar, one of Silica #pottery');
  await expect(s.locator('main strong')).toHaveText('feldspar');
  await expect(s.getByRole('checkbox', { name: /buy cones/ })).toBeDisabled();
  const text = (await s.locator('body').innerText()).toLowerCase();
  for (const away of ['keep this private', '@goblin', 'instructions', 'linked from', 'history']) {
    expect(text).not.toContain(away);
  }
  await expect(s.locator('script')).toHaveCount(0);
  await expect(s.locator('a[href^="/"]')).toHaveCount(0);
  await expect(s.locator('footer')).toHaveText('Shared from Mossgoblin');
  expect(first.refused).toEqual([]);

  // Edited: the copy shows the note as it was, until it is updated.
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await note(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await typeLines(page, ['', 'Fire to cone 6']);
  await letItSave(page);
  await s.reload();
  await expect(s.locator('main')).not.toContainText('Fire to cone 6');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const update = page.getByRole('button', { name: 'Update the shared copy' });
  await expect(update).toBeEnabled();
  await update.click();
  await expect(update).toBeDisabled();
  await letItSave(page);
  await s.reload();
  await expect(s.locator('main')).toContainText('Fire to cone 6');

  // Settings, Shared links, lists it.
  await openSettings(page, 'Shared links');
  const list = page.getByRole('list', { name: 'Shared notes' });
  await expect(list).toContainText(new URL(link).pathname);
  const row = list.getByRole('listitem');
  await expect(row).toHaveCount(1);
  const named = (await row.getByRole('link').textContent())!.trim();
  const noteHref = (await row.getByRole('link').getAttribute('href'))!;
  expect(noteHref).toMatch(/^\/n\/\w+$/);

  // Stopped: the link answers the plain 404, as a link never shared does.
  await list.getByRole('button', { name: `Stop sharing ${named}` }).click();
  await expect(page.getByText('Nothing is shared.')).toBeVisible();
  await letItSave(page);
  const stopped = (await s.goto(link))!;
  expect(stopped.status()).toBe(404);
  await expect(s.getByRole('heading', { level: 1 })).toHaveText('Nothing here');
  const stoppedPage = await stopped.text();
  // The same page and status as an id never shared, and a malformed one.
  for (const other of [`/s/${'A'.repeat(32)}`, '/s/not-an-id']) {
    const res = (await s.goto(new URL(other, link).toString()))!;
    expect(res.status()).toBe(404);
    expect(await res.text()).toBe(stoppedPage);
  }

  // Shared again: a new link; the old one stays gone.
  await page.goto(noteHref);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Share a copy' }).click();
  const again = await sharedLink(page);
  expect(again).not.toBe(link);
  await letItSave(page);
  expect((await s.goto(link))!.status()).toBe(404);
  expect((await s.goto(again))!.status()).toBe(200);
  await expect(s.getByRole('heading', { level: 1 })).not.toBeEmpty();

  // The owner's own browser, under the app's service worker, gets the
  // same page, never the app shell.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 })
    .toBe(true);
  const own = (await page.goto(again))!;
  expect(own.status()).toBe(200);
  await expect(page.locator('footer')).toHaveText('Shared from Mossgoblin');
  await expect(page.locator('script')).toHaveCount(0);

  // Moved to Trash: the copy stops with it.
  await page.goto(noteHref);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await letItSave(page);
  expect((await s.goto(again))!.status()).toBe(404);
  await first.context.close();
});

test('a shared recipe’s page carries schema.org Recipe JSON-LD', async ({ page, browser }) => {
  await signInAs(page, OWNER);
  await openSettings(page, 'Modules');
  await page.getByRole('switch', { name: 'Kitchen' }).check();
  await letItSave(page);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Kitchen' })).toBeChecked();
  await page.goto('/browse/recipes');
  await page.getByRole('textbox', { name: 'New recipe' }).fill('Potato gratin');
  await page.getByRole('textbox', { name: 'New recipe' }).press('Enter');
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await note(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('- 1 kg potatoes, sliced');
  await letItSave(page);
  await letItSave(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('textbox', { name: 'Source' }).fill('https://recipes.example/gratin');
  await page.getByRole('textbox', { name: 'Source' }).blur();
  await letItSave(page);
  await page.getByRole('button', { name: 'Share a copy' }).click();
  const link = await sharedLink(page);
  await letItSave(page);

  const { context, stranger, res, refused } = await openAsStranger(browser, link);
  expect(res.status()).toBe(200);
  await expect(stranger.getByRole('heading', { level: 1 })).toHaveText('Potato gratin');
  await expect(stranger.getByRole('link', { name: 'recipes.example' })).toHaveAttribute(
    'href',
    'https://recipes.example/gratin',
  );
  const ld = stranger.locator('script[type="application/ld+json"]');
  await expect(ld).toHaveCount(1);
  const recipe = JSON.parse((await ld.textContent())!);
  expect(recipe).toMatchObject({
    '@type': 'Recipe',
    name: 'Potato gratin',
    recipeIngredient: ['1 kg potatoes, sliced'],
    isBasedOn: 'https://recipes.example/gratin',
  });
  // A data block, not a script: the policy, which allows no script,
  // refused nothing on the page.
  expect(refused).toEqual([]);
  await context.close();
});
