import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The Reader (#159): the module switched on, an OPML file imported into
// folders (#160), the server's refresh against the emulator's fixture
// feeds (#161), then reading: folders with counts, the compact list,
// swipes, the article, next by keyboard, Saved, Mark all read (#162).

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Eric subscriptions in feedly Cloud</title></head>
  <body>
    <outline text="Design" title="Design">
      <outline type="rss" text="Design notes" xmlUrl="https://feeds.invalid/design.xml" htmlUrl="https://design.invalid/"/>
      <outline type="rss" text="Kottke" xmlUrl="https://kottke.org/main/index.xml" htmlUrl="https://kottke.org/"/>
    </outline>
    <outline text="Games">
      <outline type="rss" text="Dice" xmlUrl="https://feeds.invalid/games.atom"/>
    </outline>
    <outline type="rss" text="Loose" xmlUrl="https://loose.example/rss"/>
  </body>
</opml>`;

const swipe = async (page: Page, text: string, dx: number) => {
  const row = page
    .getByRole('list', { name: 'Articles' })
    .getByRole('listitem')
    .filter({ hasText: text });
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
};

const axe = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
};

test('import feeds, refresh, read through a folder with swipes and keys, save, mark all read', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await page.goto('/browse');
  await expect(page.getByRole('link', { name: /^Reader/ })).toHaveCount(0);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await page.goto('/browse');
  await page.getByRole('link', { name: /^Reader/ }).click();
  await expect(page.getByRole('heading', { name: 'Reader', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Import a file from your reader' }).click();
  await expect(page.getByRole('heading', { name: 'Manage feeds', level: 1 })).toBeVisible();

  // Step 1: the file, twice; a move; a removal; one followed by its link.
  await page.getByLabel('Choose an OPML file').setInputFiles({
    name: 'feedly.opml',
    mimeType: 'text/x-opml',
    buffer: Buffer.from(OPML),
  });
  await expect(page.getByRole('status')).toContainText('4 feeds added');
  const folders = page.getByRole('list', { name: 'Folders' });
  const groups = folders.getByRole('group');
  await expect(groups).toHaveCount(3);
  await expect(groups).toContainText(['Design', 'Games', 'Uncategorized']);
  await folders.locator('summary', { hasText: 'Design' }).click();
  const design = page.getByRole('list', { name: 'Feeds in Design' });
  await expect(design.getByRole('listitem')).toHaveCount(2);
  await expect(design).toContainText('design.invalid · not looked at yet');
  await axe(page);
  await page.getByLabel('Choose an OPML file').setInputFiles({
    name: 'feedly.opml',
    mimeType: 'text/x-opml',
    buffer: Buffer.from(OPML),
  });
  await expect(page.getByRole('status')).toContainText('0 feeds added, 4 already followed');
  const kottke = design.getByRole('textbox', { name: 'Folders for Kottke, comma separated' });
  await kottke.fill('Apple, Design');
  await kottke.press('Enter');
  await expect(folders).toContainText('Apple');
  await folders.locator('summary', { hasText: 'Uncategorized' }).click();
  await page.getByRole('button', { name: 'Remove: Loose' }).click();
  await expect(folders).not.toContainText('Uncategorized');
  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://feeds.invalid/page.html');
  await page.getByRole('combobox', { name: 'Folder' }).fill('Games');
  await page.getByRole('button', { name: 'Follow' }).click();
  await expect(page.getByRole('status').last()).toContainText('Following');
  await letItSave(page);

  // Step 2: Refresh from the front; the fixtures answer, the rest cannot be reached.
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Reader', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Looked at 4 feeds: 5 new articles, 2 could not be read.',
    { timeout: 30_000 },
  );
  const nav = page.getByRole('navigation', { name: 'Folders' });
  await expect(nav.getByRole('link', { name: /^All/ })).toContainText('5 unread');
  await expect(nav.getByRole('link', { name: /^Design/ })).toContainText('3 unread');
  await expect(nav.getByRole('link', { name: /^Games/ })).toContainText('2 unread');
  await expect(nav.getByRole('link', { name: /^Apple/ })).not.toContainText('unread');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('Refreshed a moment ago');

  // Step 3: the list, a swipe, the article, next by key, Show read.
  await nav.getByRole('link', { name: /^Design/ }).click();
  await expect(page.getByRole('heading', { name: 'Design', level: 1 })).toBeVisible();
  const articles = page.getByRole('list', { name: 'Articles' });
  await expect(articles.getByRole('listitem')).toHaveCount(3);
  await expect(articles.getByRole('listitem').first()).toContainText('Three chairs');
  await expect(articles.getByRole('listitem').first()).toContainText('Design notes ·');
  await expect(articles.getByRole('listitem').first()).toContainText(
    'A look at three chairs worth sitting in. One Two',
  );
  await axe(page);
  await swipe(page, 'A quiet week', -120);
  await expect(articles.getByRole('listitem')).toHaveCount(2);
  await articles.getByRole('link', { name: /Three chairs/ }).click();
  await expect(page.getByRole('heading', { name: 'Three chairs', level: 1 })).toBeVisible();
  const body = page.locator('.body');
  await expect(body.locator('strong')).toHaveText('three chairs');
  await expect(body).not.toContainText('ignore the gardener');
  await expect(body.getByRole('listitem')).toHaveText(['One', 'Two']);
  await expect(page.getByRole('link', { name: 'Open the page' })).toHaveAttribute(
    'href',
    'https://design.invalid/three-chairs',
  );
  await expect(page.getByRole('button', { name: 'Keep unread' })).toBeVisible();
  await axe(page);
  await page.keyboard.press('j');
  await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save for later' }).click();
  await expect(page.getByRole('button', { name: 'Unsave' })).toBeVisible();
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Design', level: 1 })).toBeVisible();
  await expect(page.getByText('All caught up.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Show read' }).check();
  await expect(articles.getByRole('listitem')).toHaveCount(3);
  await expect(articles.getByRole('listitem').filter({ hasText: 'Celadon' })).toContainText('★');

  // Saved is a folder; Games is marked read in one go.
  await page.goto('/reader/f/saved');
  await expect(page.getByRole('heading', { name: 'Saved', level: 1 })).toBeVisible();
  // Saved keeps what is saved, read or not.
  await expect(articles.getByRole('listitem')).toHaveCount(1);
  await expect(articles.getByRole('listitem').first()).toContainText('Celadon glazes');
  await page.goto('/browse');
  await expect(page.getByRole('link', { name: /^Reader/ })).toContainText('2 unread');
  await page.goto('/reader/f/Games');
  await expect(articles.getByRole('listitem')).toHaveCount(2);
  await expect(articles.getByRole('listitem').first()).toContainText('Dice ·');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('status')).toContainText('2 marked read.');
  await expect(page.getByText('All caught up.')).toBeVisible();

  // Images are a setting of the gardener's, kept across devices.
  await page.goto('/settings');
  const images = page.getByRole('switch', { name: 'Show images in articles' });
  await expect(images).toBeChecked();
  await images.uncheck();
  await letItSave(page);
  await page.reload();
  await expect(images).not.toBeChecked();
});
