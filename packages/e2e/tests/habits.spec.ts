import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  FIRESTORE_EMULATOR,
  expect,
  letItSave,
  signInAs,
  switchModulesOn,
  test,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// Habits (#324, step 2, 2026-11-21): a module, off until switched on;
// daily, done-only habits added on their own screen, ticked, skipped or
// logged for yesterday on Right Now, with Undo; the week strip and the
// streak on the Habits screen; Archived. The page's zone is UTC, and
// the habits are made with the page's clock set back a day, so
// yesterday is a day they were there for: the clock is never set ahead
// of the real one, which the emulator's tokens are stamped by.

test.use({ timezoneId: 'UTC' });

const DAY = 24 * 60 * 60 * 1000;

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

const habitsOnRightNow = (page: Page) => page.getByRole('region', { name: 'Habits' });
const card = (page: Page, name: string) =>
  page.locator('app-habit-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Adds a habit on the Habits screen, from + or the empty state's button. */
async function addHabit(page: Page, name: string, time?: string): Promise<void> {
  const first = page.getByRole('button', { name: 'Add your first habit' });
  if (await first.isVisible()) await first.click();
  else await page.getByRole('button', { name: 'Add a habit' }).click();
  const form = page.getByRole('form', { name: 'New habit' });
  await form.getByRole('textbox', { name: 'Habit' }).fill(name);
  if (time) await form.getByLabel(/Time of day/).fill(time);
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(card(page, name)).toBeVisible();
}

/** The owner's month logs as stored, read as admin: each day's state, by log id. */
async function storedLogs(): Promise<Record<string, Record<string, string>>> {
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/habitLogs`,
    { headers: { authorization: 'Bearer owner' } },
  );
  const { documents = [] } = (await res.json()) as {
    documents?: {
      name: string;
      fields?: {
        days?: {
          mapValue?: {
            fields?: Record<
              string,
              { mapValue?: { fields?: { state?: { stringValue?: string } } } }
            >;
          };
        };
      };
    }[];
  };
  return Object.fromEntries(
    documents.map((d) => [
      d.name.split('/').pop()!,
      Object.fromEntries(
        Object.entries(d.fields?.days?.mapValue?.fields ?? {}).map(([k, v]) => [
          k,
          v.mapValue?.fields?.state?.stringValue ?? '',
        ]),
      ),
    ]),
  );
}

test('habits: on, added, ticked with Undo, skipped, logged for yesterday, archived', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signInAs(page, OWNER);

  // Off: no tile, no section, and its screen says where to switch it on.
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'Mossgoblin', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Habits/ })).toHaveCount(0);
  await page.goto('/habits');
  await expect(page.getByText('Habits is a module that is switched off.')).toBeVisible();

  await switchModulesOn(page, 'Habits');

  // Yesterday, the habits are made.
  const realNow = Date.now();
  await page.clock.setFixedTime(realNow - DAY);
  await page.goto('/habits');
  await expect(page.getByText(/A habit is something you mean to do every day/)).toBeVisible();
  await noSeriousViolations(page);
  await addHabit(page, 'Floss', '21:00');
  await addHabit(page, 'Read a page');
  await addHabit(page, 'Run');
  await letItSave(page);

  // Today.
  await page.clock.setFixedTime(realNow);
  await page.goto('/right-now');
  const section = habitsOnRightNow(page);
  // A time of day first, by time; then the rest, by name.
  await expect(section.getByRole('listitem')).toHaveText([
    /^Floss\s*21:00/,
    /^Read a page/,
    /^Run/,
  ]);
  // Each can still be logged for yesterday, quietly, on its row.
  await expect(section.getByRole('button', { name: /^Yesterday\?/ })).toHaveCount(3);

  // Tick, Undo, tick again.
  await section.getByRole('button', { name: 'Done: Floss' }).click();
  await expect(section.getByRole('button', { name: 'Done: Floss' })).toHaveCount(0);
  await expect(section).toContainText('Done today: Floss');
  await expect(section.getByRole('status')).toContainText('Floss: done');
  await section.getByRole('button', { name: 'Undo' }).click();
  await expect(section.getByRole('button', { name: 'Done: Floss' })).toBeVisible();
  await expect(section).not.toContainText('Done today');
  await section.getByRole('button', { name: 'Done: Floss' }).click();
  await expect(section).toContainText('Done today: Floss');

  // Still done for a fresh load: it was written, not just shown.
  await letItSave(page);
  await page.reload();
  await expect(section).toContainText('Done today: Floss');
  await expect(section.getByRole('button', { name: 'Done: Floss' })).toHaveCount(0);

  // Skip one; log yesterday on another.
  await section.getByRole('button', { name: 'Skip: Run' }).click();
  await expect(section).toContainText('Skipped today: Run');
  await section.getByRole('button', { name: 'Yesterday? Mark Read a page done yesterday' }).click();
  await expect(section.getByRole('status')).toContainText('Read a page: done yesterday');
  // Still to do today, its yesterday logged.
  await expect(section.getByRole('button', { name: 'Done: Read a page' })).toBeVisible();
  await expect(
    section.getByRole('button', { name: /Mark Read a page done yesterday/ }),
  ).toHaveCount(0);
  await letItSave(page);

  // The Habits screen: the strip, each day in words, and the streak.
  await page.goto('/habits');
  const floss = card(page, 'Floss');
  const strip = floss.getByRole('list', { name: 'The last seven days of Floss' });
  const days = strip.getByRole('listitem');
  await expect(days).toHaveCount(7);
  await expect(days.nth(6)).toContainText(': done');
  // Yesterday is empty, but can still be logged: not missed yet.
  await expect(days.nth(5)).toContainText(': not logged yet');
  await expect(days.nth(0)).toContainText(': before the habit began');
  await expect(floss).toContainText('21:00 · Streak: 1 day');
  await expect(floss.getByRole('button', { name: 'Done today: Floss' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const read = card(page, 'Read a page');
  await expect(read).toContainText('Streak: 1 day');
  await expect(read.getByRole('button', { name: 'Done yesterday: Read a page' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(card(page, 'Run').getByRole('list').getByRole('listitem').nth(6)).toContainText(
    ': skipped',
  );
  expect(await noSidewaysScroll(page)).toBe(true);
  await noSeriousViolations(page);

  // Archive one: it leaves Right Now, its history stays under Archived.
  await card(page, 'Run').getByRole('button', { name: 'Edit Run' }).click();
  await card(page, 'Run').getByRole('button', { name: 'Archive' }).click();
  const archived = page.getByRole('region', { name: 'Archived' });
  await expect(archived.getByRole('heading', { name: 'Run', level: 3 })).toBeVisible();
  await expect(archived.getByRole('list', { name: 'The last seven days of Run' })).toBeVisible();
  await expect(archived.getByRole('button', { name: 'Unarchive Run' })).toBeVisible();
  await letItSave(page);
  await page.goto('/right-now');
  await expect(section.getByRole('button', { name: 'Done: Read a page' })).toBeVisible();
  await expect(section).not.toContainText('Run');
  await noSeriousViolations(page);

  // The Home tile counts today's.
  await page.goto('/home');
  await expect(page.getByRole('link', { name: /^Habits/ })).toContainText('1 of 2 today');

  // Offline, a tick is kept and shown, and reaches the server once online.
  await page.goto('/right-now');
  await expect(section.getByRole('button', { name: 'Done: Read a page' })).toBeVisible();
  await page.context().setOffline(true);
  await section.getByRole('button', { name: 'Done: Read a page' }).click();
  await expect(section).toContainText('Done today: Floss, Read a page');
  await page.context().setOffline(false);
  await letItSave(page);
  const today = new Date(realNow).toISOString().slice(0, 10);
  const yesterday = new Date(realNow - DAY).toISOString().slice(0, 10);
  // Every habit's check-in for a day, from the month log of that day.
  const stateOn = (logs: Record<string, Record<string, string>>, day: string) =>
    Object.entries(logs)
      .filter(([id]) => id.endsWith(`_${day.slice(0, 7)}`))
      .map(([, days]) => days[day.slice(8)])
      .filter(Boolean)
      .sort();
  await expect
    .poll(async () => {
      const logs = await storedLogs();
      return { today: stateOn(logs, today), yesterday: stateOn(logs, yesterday) };
    })
    .toEqual({ today: ['done', 'done', 'skipped'], yesterday: ['done'] });
});

for (const { label, viewport, rail } of [
  { label: 'a tablet', viewport: { width: 768, height: 1024 }, rail: true },
  { label: 'a desktop', viewport: { width: 1440, height: 900 }, rail: true },
  { label: 'a narrow phone', viewport: { width: 320, height: 640 }, rail: false },
]) {
  test.describe(`on ${label}`, () => {
    test.use({ isMobile: false, hasTouch: false, viewport });

    test('the Habits screen holds, in the rail while the module is on', async ({ page }) => {
      test.setTimeout(90_000);
      await signInAs(page, OWNER);
      const places = page.getByRole('navigation', { name: 'Places', exact: true });
      if (rail) {
        await page.goto('/home');
        await expect(places).toBeVisible();
        await expect(places.getByRole('link', { name: 'Habits' })).toHaveCount(0);
      }
      await switchModulesOn(page, 'Habits');
      await page.goto('/habits');
      await addHabit(
        page,
        'Walk the long way round past the allotments and back by the canal towpath',
        '07:30',
      );
      await letItSave(page);
      if (rail) {
        await expect(places.locator('a[aria-current="page"] .name')).toHaveText(['Habits']);
        await places.getByRole('link', { name: 'Right Now' }).click();
        await expect(page).toHaveURL(/\/right-now$/);
        await places.getByRole('link', { name: 'Habits' }).click();
        await expect(page).toHaveURL(/\/habits$/);
      }
      expect(await noSidewaysScroll(page)).toBe(true);
      await page.goto('/right-now');
      await expect(habitsOnRightNow(page).getByRole('listitem')).toHaveCount(1);
      expect(await noSidewaysScroll(page)).toBe(true);
    });
  });
}
