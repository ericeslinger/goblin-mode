import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  SETTINGS_PAGE_NAMES,
  type SettingsPageName,
  expect,
  letItSave,
  openSettings,
  signInAs,
  switchModulesOn,
  test,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// Settings as pages (#290, step 6 of the layout pass, 2026-11-16): a
// first screen of rows, each opening its own page; on a wide screen the
// list is a column with the page beside it.

async function noSeriousViolations(page: Page, where: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${where}: ${v.id}: ${v.help}`)).toEqual([]);
}

const rows = (page: Page) => page.getByRole('navigation', { name: 'Settings', exact: true });
const row = (page: Page, name: SettingsPageName) =>
  rows(page).getByRole('link', { name, exact: true });

/** A 44 px tap: the centre and 21 px each way land on the control. */
async function missedTaps(control: Locator): Promise<string[]> {
  await control.scrollIntoViewIfNeeded();
  return control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    const missed: string[] = [];
    for (const [dx, dy] of [
      [0, 0],
      [0, -21],
      [0, 21],
      [-21, 0],
      [21, 0],
    ]) {
      const hit = document.elementFromPoint(x + dx, y + dy);
      if (!hit || !el.contains(hit)) missed.push(`${dx},${dy}`);
    }
    return missed;
  });
}

/** Kitchen, the Reader and Podcasts on, so their settings show. */
async function everyModuleOn(page: Page): Promise<void> {
  // The shared helper: Podcasts follows the Reader's switch (#245), and
  // a click on it while it is switching itself on turned it off again.
  await switchModulesOn(page, 'Kitchen', 'Reader', 'Podcasts');
}

/**
 * What each page holds, and a control from another page it must not:
 * a control lost in the move, or left on the wrong page, fails here.
 */
const HOLDS: Record<
  SettingsPageName,
  { has: (page: Page) => Locator[]; not: (page: Page) => Locator }
> = {
  Appearance: {
    has: (p) => [
      p.getByRole('radio', { name: /^Herbarium/ }),
      p.getByRole('radio', { name: 'Dark', exact: true }),
      p.getByRole('radio', { name: 'Follow the system' }),
    ],
    not: (p) => p.getByRole('radiogroup', { name: 'Start on' }),
  },
  'Start on': {
    has: (p) => [
      p.getByRole('radiogroup', { name: 'Start on' }),
      p.getByRole('radio', { name: /^Where I left off/ }),
      p.getByRole('radio', { name: /^Right Now/ }),
    ],
    not: (p) => p.getByRole('radio', { name: /^Herbarium/ }),
  },
  Modules: {
    has: (p) => [
      p.getByRole('switch', { name: 'Projects' }),
      p.getByRole('combobox', { name: 'Weeks start on' }),
      p.getByRole('combobox', { name: 'Keep articles for' }),
      p.getByRole('switch', { name: 'Mark articles read as I scroll past them' }),
    ],
    not: (p) => p.getByRole('switch', { name: 'Download new episodes on their own only on Wi-Fi' }),
  },
  Templates: {
    has: (p) => [
      p.getByRole('button', { name: 'New template', exact: true }),
      p.getByRole('button', { name: 'New living template' }),
      p.getByRole('button', { name: 'Add a feelings journal' }),
    ],
    not: (p) => p.getByRole('button', { name: 'Sign out' }),
  },
  'AI assistants': {
    has: (p) => [
      p.getByRole('list', { name: 'API keys' }).getByRole('textbox', { name: 'Anthropic key' }),
      p.getByRole('switch', { name: 'A daily digest by push' }),
      p.getByRole('button', { name: 'Disconnect all assistants' }),
      p.getByRole('link', { name: 'Context for Claude' }),
    ],
    not: (p) => p.getByRole('button', { name: 'New template', exact: true }),
  },
  Notifications: {
    has: (p) => [p.getByRole('button', { name: 'Turn on notifications' })],
    not: (p) => p.getByRole('button', { name: 'Check for updates' }),
  },
  'This device': {
    has: (p) => [
      p.getByRole('combobox', { name: 'Downloaded episodes kept on this device, at most' }),
      p.getByRole('switch', { name: 'Download new episodes on their own only on Wi-Fi' }),
      p.getByRole('button', { name: 'Check for updates' }),
    ],
    not: (p) => p.getByRole('switch', { name: 'Projects' }),
  },
  Account: {
    has: (p) => [
      p.getByText(`Signed in as ${OWNER.email}`),
      p.getByRole('button', { name: 'Sign out' }),
      p.getByRole('heading', { name: 'Sealed notes', level: 2 }),
    ],
    not: (p) => p.getByRole('button', { name: 'Turn on notifications' }),
  },
};

test.describe('on a phone', () => {
  test.beforeEach(async ({ page, context }) => {
    // So Notifications offers its button, as notifications.spec does.
    await context.grantPermissions(['notifications']);
    await signInAs(page, OWNER);
  });

  test('the list fits in two screens, each row a 44 px link to its page', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(rows(page).getByRole('link')).toHaveCount(SETTINGS_PAGE_NAMES.length);
    // Each row's quiet line says how it stands, apart from its name.
    await expect(row(page, 'Start on')).toHaveAccessibleDescription('Where I left off');
    await expect(row(page, 'Account')).toHaveAccessibleDescription(OWNER.email);
    const viewport = page.viewportSize()!;
    expect(viewport).toEqual({ width: 412, height: 839 });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(height).toBeLessThan(1700);
    await noSeriousViolations(page, 'the list');

    for (const name of SETTINGS_PAGE_NAMES) {
      const link = row(page, name);
      const box = (await link.boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(44);
      expect(await missedTaps(link), name).toEqual([]);
      await link.click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      // A phone shows the page alone: the list is a tap back.
      await expect(rows(page)).toBeHidden();
      await page.getByRole('link', { name: 'Back to Settings', exact: true }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(rows(page)).toBeVisible();
    }
  });

  test('each page holds its own controls, and passes axe', async ({ page }) => {
    test.setTimeout(120_000);
    await everyModuleOn(page);
    for (const name of SETTINGS_PAGE_NAMES) {
      await openSettings(page, name);
      for (const control of HOLDS[name].has(page)) {
        await expect(control, name).toBeVisible({ timeout: 15_000 });
      }
      await expect(HOLDS[name].not(page), name).toHaveCount(0);
      await noSeriousViolations(page, name);
    }
  });

  test('a page opens from its own address, after a reload and on relaunch; old links land on their page', async ({
    page,
  }) => {
    // The off screens' links, with Kitchen, the Reader and Podcasts
    // still off.
    await page.goto('/kitchen');
    await page.getByRole('link', { name: 'Switch it on in Settings, Modules' }).click();
    await expect(page).toHaveURL(/\/settings\/modules$/);
    await expect(page.getByRole('switch', { name: 'Kitchen' })).toBeVisible();
    await page.goto('/reader');
    await page.getByRole('link', { name: 'Settings, Modules' }).click();
    await expect(page).toHaveURL(/\/settings\/modules$/);
    await page.goto('/podcasts');
    await page.getByRole('link', { name: 'Settings, Modules' }).click();
    await expect(page).toHaveURL(/\/settings\/modules$/);

    // An anchor of the one long page, as a link or a kept place had it.
    await page.goto('/settings#downloads');
    await expect(page).toHaveURL(/\/settings\/device$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This device');
    await page.goto('/settings#modules');
    await expect(page).toHaveURL(/\/settings\/modules$/);
    await page.goto('/settings#sealing');
    await expect(page).toHaveURL(/\/settings\/account$/);
    // A page this version does not know: the list.
    await page.goto('/settings/nowhere');
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');

    await page.goto('/settings/device');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This device');
    await expect(page.getByRole('button', { name: 'Check for updates' })).toBeVisible();

    // Where I left off (#272): a launch reopens the page, by its address alone.
    await openSettings(page, 'AI assistants');
    await expect(page.getByRole('switch', { name: 'A daily digest by push' })).toBeVisible();
    await letItSave(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/settings\/assistants$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI assistants');
    await expect(page.getByRole('button', { name: 'Disconnect all assistants' })).toBeVisible();
  });
});

test.describe('on a wide screen', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test('the list and one page side by side, the page’s row marked', async ({ page }) => {
    await signInAs(page, OWNER);
    await page.goto('/settings');
    // At /settings the first page shows beside the list.
    await expect(rows(page)).toBeVisible();
    const herbarium = page.getByRole('radio', { name: /^Herbarium/ });
    await expect(herbarium).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await noSeriousViolations(page, 'wide, the list');

    await row(page, 'Modules').click();
    await expect(page).toHaveURL(/\/settings\/modules$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Modules');
    await expect(row(page, 'Modules')).toHaveAttribute('aria-current', 'page');
    await expect(rows(page).locator('[aria-current="page"]')).toHaveCount(1);
    const projects = page.getByRole('switch', { name: 'Projects' });
    await expect(projects).toBeVisible();
    const list = (await rows(page).boundingBox())!;
    const control = (await projects.boundingBox())!;
    // Beside, not under: the page starts right of the list, level with it.
    expect(control.x).toBeGreaterThanOrEqual(list.x + list.width);
    expect(control.y).toBeLessThan(list.y + list.height);
    // The list is the way back here.
    await expect(page.getByRole('link', { name: 'Back to Settings' })).toHaveCount(0);
    await noSeriousViolations(page, 'wide, Modules');

    await row(page, 'Account').click();
    await expect(row(page, 'Account')).toHaveAttribute('aria-current', 'page');
    await expect(row(page, 'Modules')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await noSeriousViolations(page, 'wide, Account');
  });
});
