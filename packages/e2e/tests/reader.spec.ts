import AxeBuilder from '@axe-core/playwright';
import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The Reader (#159), step 1 (#160): the module switched on, an OPML
// file imported into folders, a feed moved and removed, one followed by
// its link.

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Eric subscriptions in feedly Cloud</title></head>
  <body>
    <outline text="Design" title="Design">
      <outline type="rss" text="Kottke" xmlUrl="https://kottke.org/main/index.xml" htmlUrl="https://kottke.org/"/>
      <outline type="rss" text="Daring Fireball" xmlUrl="https://daringfireball.net/feeds/main" htmlUrl="https://daringfireball.net/"/>
    </outline>
    <outline text="Games">
      <outline type="rss" text="Kottke" xmlUrl="https://kottke.org/main/index.xml" htmlUrl="https://kottke.org/"/>
    </outline>
    <outline type="rss" text="Loose" xmlUrl="https://loose.example/rss"/>
  </body>
</opml>`;

test('import an OPML file into folders, move a feed, remove one, follow one', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/browse');
  await expect(page.getByRole('link', { name: 'Reader' })).toHaveCount(0);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await page.goto('/browse');
  await page.getByRole('link', { name: 'Reader' }).click();
  await expect(page.getByRole('heading', { name: 'Reader', level: 1 })).toBeVisible();
  await expect(page.getByText('No feeds yet')).toBeVisible();

  await page.getByLabel('Choose an OPML file').setInputFiles({
    name: 'feedly.opml',
    mimeType: 'text/x-opml',
    buffer: Buffer.from(OPML),
  });
  await expect(page.getByRole('status')).toContainText('3 feeds added');
  const folders = page.getByRole('list', { name: 'Folders' });
  const groups = folders.getByRole('group');
  await expect(groups).toHaveCount(3);
  await expect(groups).toContainText(['Design', 'Games', 'Uncategorized']);
  await folders.locator('summary', { hasText: 'Design' }).click();
  const design = page.getByRole('list', { name: 'Feeds in Design' });
  await expect(design.getByRole('listitem')).toHaveCount(2);
  await expect(design).toContainText('kottke.org · not looked at yet');

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Importing the same file again adds nothing.
  await page.getByLabel('Choose an OPML file').setInputFiles({
    name: 'feedly.opml',
    mimeType: 'text/x-opml',
    buffer: Buffer.from(OPML),
  });
  await expect(page.getByRole('status')).toContainText('0 feeds added, 3 already followed');

  // Daring Fireball moves to a new folder; Loose goes.
  await design
    .getByRole('textbox', { name: 'Folders for Daring Fireball, comma separated' })
    .fill('Apple, Design');
  await design
    .getByRole('textbox', { name: 'Folders for Daring Fireball, comma separated' })
    .press('Enter');
  await expect(folders).toContainText('Apple');
  await folders.locator('summary', { hasText: 'Uncategorized' }).click();
  await page.getByRole('button', { name: 'Remove: Loose' }).click();
  await expect(folders).not.toContainText('Uncategorized');

  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://dice.example/feed');
  await page.getByRole('combobox', { name: 'Folder' }).fill('Games');
  await page.getByRole('button', { name: 'Follow' }).click();
  await expect(page.getByRole('status').last()).toContainText('Following');
  await folders.locator('summary', { hasText: 'Games' }).click();
  await expect(page.getByRole('list', { name: 'Feeds in Games' })).toContainText('dice.example');
  await letItSave(page);

  // Kept: the feeds are the gardener's data, not this page's.
  await page.reload();
  await expect(groups).toHaveCount(3);
  await expect(groups).toContainText(['Apple', 'Design', 'Games']);
});
