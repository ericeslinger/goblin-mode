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
// done-only habits added on their own screen (daily; weekly and monthly
// since step 5, 2026-11-22, their own journey below), ticked, skipped or
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

/**
 * Adds a habit on the Habits screen, from + or the empty state's button;
 * every day unless `often` ("Once a week", "Once a month") is given.
 */
async function addHabit(page: Page, name: string, time?: string, often?: string): Promise<void> {
  const first = page.getByRole('button', { name: 'Add your first habit' });
  if (await first.isVisible()) await first.click();
  else await page.getByRole('button', { name: 'Add a habit' }).click();
  const form = page.getByRole('form', { name: 'New habit' });
  await form.getByRole('textbox', { name: 'Habit' }).fill(name);
  if (often) await form.getByRole('combobox', { name: 'How often' }).selectOption({ label: often });
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
  // The row ticked went; the focus is on its Undo, then on the heading
  // (review of #328, 2026-11-21).
  await expect(section.getByRole('button', { name: 'Undo' })).toBeFocused();
  await section.getByRole('button', { name: 'Undo' }).click();
  await expect(section.getByRole('link', { name: 'Habits' })).toBeFocused();
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
  await expect(archived.getByRole('button', { name: 'Unarchive Run' })).toBeFocused();
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

/** The owner's habit log at `id`, written as admin, past the rules. */
async function seedLog(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const [habit, month] = id.split('_');
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/habitLogs/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({
        fields: {
          habit: { stringValue: habit },
          month: { stringValue: month },
          days: { mapValue: {} },
          updatedAt: { timestampValue: new Date().toISOString() },
          ...extra,
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`could not seed ${id}: ${await res.text()}`);
}

/** The owner's habits' ids, read as admin. */
async function storedHabitIds(): Promise<string[]> {
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/habits`,
    { headers: { authorization: 'Bearer owner' } },
  );
  const { documents = [] } = (await res.json()) as { documents?: { name: string }[] };
  return documents.map((d) => d.name.split('/').pop()!);
}

// A tick the server refuses (review of #327, 2026-11-21): the month's
// log is given a field the rules do not allow, as admin, so the rules
// refuse every write to it, as production would refuse one past its
// limits. The tick goes, and the refusal is said, with Try again. Each
// write meant to be refused is waited out (`letItSave`: Firestore's
// pending writes settle on a refusal too) before the line is read or
// the log put right, so a retry still in flight cannot land on the
// repaired log (2026-11-21).
test('habits: a refused tick is said, and Try again sends it again', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  await switchModulesOn(page, 'Habits');
  await page.goto('/habits');
  await addHabit(page, 'Floss');
  await letItSave(page);
  await expect.poll(storedHabitIds).toHaveLength(1);
  const [id] = await storedHabitIds();
  const logId = `${id}_${new Date().toISOString().slice(0, 7)}`;
  await seedLog(logId, { stray: { booleanValue: true } });

  await page.goto('/right-now');
  const section = habitsOnRightNow(page);
  await section.getByRole('button', { name: 'Done: Floss' }).click();
  await letItSave(page);
  const alert = section.getByRole('alert');
  await expect(alert).toHaveText(/Floss could not be saved for today\./);
  // The cache is put back: Floss is still to do, and no Undo claims it.
  await expect(section.getByRole('button', { name: 'Done: Floss' })).toBeVisible();
  await expect(section).not.toContainText('Done today');
  await expect(section).not.toContainText('Floss: done');
  await noSeriousViolations(page);

  // Refused again while the log is as it was.
  await alert.getByRole('button', { name: 'Try again: Floss' }).click();
  await letItSave(page);
  await expect(alert).toHaveText(/Floss could not be saved for today\./);

  // Put right, Try again saves it, and the line goes.
  await seedLog(logId);
  await alert.getByRole('button', { name: 'Try again: Floss' }).click();
  await expect(section).toContainText('Done today: Floss');
  await expect(section.getByText(/could not be saved/)).toHaveCount(0);
  const today = new Date().toISOString().slice(8, 10);
  await expect.poll(async () => (await storedLogs())[logId]?.[today]).toBe('done');
});

/** The owner's stored habits, as admin: each one's `nudge`, by name. */
async function storedNudges(): Promise<Record<string, boolean>> {
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/habits`,
    { headers: { authorization: 'Bearer owner' } },
  );
  const { documents = [] } = (await res.json()) as {
    documents?: {
      fields?: { name?: { stringValue?: string }; nudge?: { booleanValue?: boolean } };
    }[];
  };
  return Object.fromEntries(
    documents.map((d) => [
      d.fields?.name?.stringValue ?? '',
      d.fields?.nudge?.booleanValue ?? false,
    ]),
  );
}

/** The owner's registered devices' tokens, as admin. */
async function deviceTokens(): Promise<string[]> {
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/devices`,
    { headers: { authorization: 'Bearer owner' } },
  );
  const { documents = [] } = (await res.json()) as {
    documents?: { fields?: { token?: { stringValue?: string } } }[];
  };
  return documents.map((d) => d.fields?.token?.stringValue ?? '');
}

// Nudges (step 4 of #324, 2026-11-21): Nudge me in Edit needs a time,
// and switched on the first time it turns this device's notifications
// on, through Settings' own path (on localhost a stand-in token, as
// the notifications journey has). No push is sent here: the emulator
// has no FCM, and the sender's specs cover what is sent.
test('habits: Nudge me needs a time and turns notifications on', async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(['notifications']);
  await signInAs(page, OWNER);
  await switchModulesOn(page, 'Habits');
  await page.goto('/habits');
  await addHabit(page, 'Floss');
  await letItSave(page);

  const floss = card(page, 'Floss');
  await floss.getByRole('button', { name: 'Edit Floss' }).click();
  const form = page.getByRole('form', { name: 'Edit Floss' });
  const nudge = form.getByRole('switch', { name: 'Nudge me' });
  await expect(nudge).toBeDisabled();
  await expect(form).toContainText('A nudge needs a time of day.');
  await form.getByLabel(/Time of day/).fill('21:00');
  await expect(nudge).toBeEnabled();
  await expect(form).toContainText('One push at 21:00 if not logged by then.');
  await noSeriousViolations(page);
  await nudge.check();
  await expect.poll(deviceTokens).toEqual(['emulator-token']);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(floss.getByText('21:00 · Nudge on')).toBeVisible();
  await letItSave(page);
  await expect.poll(storedNudges).toEqual({ Floss: true });

  // Its time cleared, the nudge goes with it.
  await floss.getByRole('button', { name: 'Edit Floss' }).click();
  await form.getByLabel(/Time of day/).fill('');
  await expect(nudge).toBeDisabled();
  await form.getByRole('button', { name: 'Save' }).click();
  await letItSave(page);
  await expect.poll(storedNudges).toEqual({ Floss: false });
});

// Weekly and monthly (step 5 of #324, 2026-11-22). The module's week is
// set to start yesterday, so yesterday and today are one week whatever
// day the run is on, and the weekly habit, made and done yesterday with
// the page's clock set back a day (never ahead: the emulator's tokens),
// is settled for the rest of its week today. A monthly one is skipped.
test('habits: once a week and once a month, settled and gone for the period', async ({ page }) => {
  test.setTimeout(150_000);
  await signInAs(page, OWNER);
  await switchModulesOn(page, 'Habits');
  const realNow = Date.now();
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(realNow - DAY).getUTCDay()
  ];
  // Settings, Modules: Habits' own week start, as Kitchen's.
  await expect(page.getByRole('heading', { name: 'Habits', level: 2 })).toBeVisible();
  const weekStart = page.getByRole('combobox', { name: 'Weeks start on' });
  await expect(weekStart).toHaveValue('Mon');
  await weekStart.selectOption(weekday);
  await expect(weekStart).toHaveValue(weekday);
  await noSeriousViolations(page);
  await letItSave(page);

  // Yesterday: both are made, and the weekly one done on Right Now.
  await page.clock.setFixedTime(realNow - DAY);
  await page.goto('/habits');
  await addHabit(page, 'Clean the pots', undefined, 'Once a week');
  await addHabit(page, 'Pay the rent', undefined, 'Once a month');
  await expect(card(page, 'Clean the pots')).toContainText('Not done yet this week');
  await letItSave(page);
  await page.goto('/right-now');
  const section = habitsOnRightNow(page);
  await expect(section.getByRole('listitem')).toHaveText([
    /^Clean the pots\s*This week/,
    /^Pay the rent\s*This month/,
  ]);
  await section.getByRole('button', { name: 'Done: Clean the pots' }).click();
  await expect(section).toContainText('Done today: Clean the pots');
  await letItSave(page);

  // Today: settled yesterday, the pots are gone for the rest of the week,
  // from the list and from the settled line both.
  await page.clock.setFixedTime(realNow);
  await page.goto('/right-now');
  await expect(section.getByRole('listitem')).toHaveText([/^Pay the rent\s*This month/]);
  await expect(section).not.toContainText('Clean the pots');
  await noSeriousViolations(page);
  await section.getByRole('button', { name: 'Skip: Pay the rent' }).click();
  await expect(section).toContainText('Skipped today: Pay the rent');
  await expect(section.getByRole('listitem')).toHaveCount(0);
  await letItSave(page);

  // Home counts what is due today: the rent, settled; not the pots.
  await page.goto('/home');
  await expect(page.getByRole('link', { name: /^Habits/ })).toContainText('1 of 1 today');

  // The Habits screen: the week's line and strip, the month's line.
  await page.goto('/habits');
  const pots = card(page, 'Clean the pots');
  await expect(pots).toContainText('Once a week · Streak: 1 week');
  await expect(pots).toContainText('Done this week, yesterday');
  const days = pots
    .getByRole('list', { name: 'The last seven days of Clean the pots' })
    .getByRole('listitem');
  await expect(days.nth(4)).toContainText(': before the habit began');
  await expect(days.nth(5)).toContainText(': done');
  await expect(days.nth(6)).toContainText(': settled that week');
  // Nothing to log today, the week being settled.
  await expect(pots.getByRole('group', { name: 'Today, Clean the pots' })).toHaveCount(0);
  const rent = card(page, 'Pay the rent');
  await expect(rent).toContainText('Once a month');
  await expect(rent).toContainText('Skipped this month, today');
  await expect(rent.getByRole('button', { name: 'Skip today: Pay the rent' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await noSidewaysScroll(page)).toBe(true);
  await noSeriousViolations(page);

  // Made daily, its history stays, read again as days: yesterday done,
  // today to do.
  await pots.getByRole('button', { name: 'Edit Clean the pots' }).click();
  const form = page.getByRole('form', { name: 'Edit Clean the pots' });
  await form.getByRole('combobox', { name: 'How often' }).selectOption({ label: 'Every day' });
  await expect(form).toContainText('What is logged stays, read again by the new schedule.');
  await form.getByRole('button', { name: 'Save' }).click();
  await letItSave(page);
  await page.reload();
  await expect(pots).toContainText('Streak: 1 day');
  await expect(pots).not.toContainText('this week');
  await expect(days.nth(5)).toContainText(': done');
  await expect(days.nth(6)).toContainText(': not logged yet');
  await expect(pots.getByRole('button', { name: 'Done today: Clean the pots' })).toBeVisible();
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
