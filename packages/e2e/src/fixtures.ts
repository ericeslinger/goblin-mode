import { type Page, test as base, expect } from '@playwright/test';
import type { Persona } from './personas';
import { AUTH_EMULATOR, FIRESTORE_EMULATOR } from './stack';

export { AUTH_EMULATOR, FIRESTORE_EMULATOR };
const PROJECT = 'demo-mossgoblin';

/**
 * Keeps journeys off the network. Off-box requests are aborted, not
 * stubbed: Firebase Auth loads apis.google.com for its popup machinery
 * and waits forever on an empty stub, but carries on when it fails.
 */
export async function prepPage(page: Page): Promise<void> {
  await page.route(/fonts\.(googleapis|gstatic)\.com|apis\.google\.com/, (r) => r.abort());
}

/**
 * Wipes every Auth emulator account and all Firestore data, then creates
 * this persona under its fixed uid, so setup is retry-safe and every
 * journey starts empty. Each worker has an emulator stack of its own
 * (./stack.ts) and runs one journey at a time, so a wipe is safe.
 */
export async function resetAccount(persona: Persona): Promise<void> {
  const base = `http://${AUTH_EMULATOR}`;
  const wiped = await fetch(`${base}/emulator/v1/projects/${PROJECT}/accounts`, {
    method: 'DELETE',
  });
  if (!wiped.ok) throw new Error(`could not wipe accounts: ${await wiped.text()}`);
  const cleared = await fetch(
    `http://${FIRESTORE_EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!cleared.ok) throw new Error(`could not clear Firestore: ${await cleared.text()}`);
  // The admin create call (Bearer owner) takes a fixed uid.
  const created = await fetch(
    `${base}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({
        localId: persona.uid,
        email: persona.email,
        password: persona.password,
      }),
    },
  );
  if (!created.ok) throw new Error(`could not create ${persona.email}: ${await created.text()}`);
}

/**
 * Signs in through the emulator-only /dev-sign-in page and waits for the
 * launch screen and the device's note key. Resets the account first, so it is retry-safe; pass
 * `{ reset: false }` to sign a second device into the same account.
 */
export async function signInAs(
  page: Page,
  persona: Persona,
  { reset = true }: { reset?: boolean } = {},
): Promise<void> {
  if (reset) await resetAccount(persona);
  await page.goto('/dev-sign-in');
  await page.getByLabel('Email').fill(persona.email);
  await page.getByLabel('Password').fill(persona.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Signing in moves to `/` inside the app, never a plain launch, so it
  // lands on the capture note whatever was open last (#272).
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeVisible();
  // Note text is always sealed (2026-11-15): until this device has its
  // key from the static server's `/api/note-key`, what is typed waits
  // on the device. The key comes at sign-in, online; waiting for it
  // here keeps journeys that read what was written from racing it.
  await expect
    .poll(() => page.evaluate((uid) => localStorage.getItem(`goblin.noteKey.${uid}`), persona.uid))
    .not.toBeNull();
}

/**
 * The capture screen, as a fresh page load, whatever was open last.
 * Until 2026-11-15 `page.goto('/')` did this; since #272 a plain `/`
 * goes back to the last place, so this comes in by Home and its box,
 * an in-app link to `/`, which shows the capture note as `/` used to.
 */
export async function openCapture(page: Page): Promise<void> {
  await page.goto('/home');
  await page.getByRole('link', { name: 'Plant a thought' }).click();
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeVisible();
}

/**
 * Types lines into the focused editor, waiting for each Enter to land:
 * the phone profile's Android user agent makes CodeMirror apply Enter
 * only after the browser's own DOM change (see DESIGN.md, Editor).
 */
export async function typeLines(page: Page, lines: string[]): Promise<void> {
  const editor = page.getByRole('textbox', { name: 'New note' });
  for (const [i, line] of lines.entries()) {
    if (i > 0) {
      const before = await editor.locator('.cm-line').count();
      await page.keyboard.press('Enter');
      await expect(editor.locator('.cm-line')).toHaveCount(before + 1);
    }
    await page.keyboard.type(line);
  }
}

/** Waits out the 300 ms save debounce, with margin. */
export async function letItSave(page: Page): Promise<void> {
  // The editor's own pause before it writes, then until the emulator has
  // every write made so far (a fixed pause alone lost a settings change
  // under load, 2026-10-18). Offline that never comes: capped.
  await page.waitForTimeout(800);
  await page
    .evaluate(() =>
      Promise.race([
        (globalThis as { mossgoblinSynced?: () => Promise<void> }).mossgoblinSynced?.(),
        new Promise((done) => setTimeout(done, 5000)),
      ]),
    )
    // A page between documents has nothing to wait for.
    .catch(() => undefined);
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await prepPage(page);
    await use(page);
  },
});

export { expect };

/**
 * Opens the launch screen's More menu (#78), where everything but
 * writing lives, and returns it.
 */
export async function openMore(page: Page) {
  // A choice just made closes More on the next render: let it land first.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
  // By how its name starts: offline the button's name goes on to say
  // so, and a reminder's text ("Order more cones") is in another's.
  const more = page.getByRole('button', { name: /^More/ });
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  const menu = page.getByRole('navigation', { name: 'More' });
  await expect(menu).toBeVisible();
  return menu;
}

/** The pages of Settings (#290), as their rows and headers name them. */
export const SETTINGS_PAGE_NAMES = [
  'Appearance',
  'Start on',
  'Modules',
  'Templates',
  'AI assistants',
  'Notifications',
  'This device',
  'Account',
] as const;
export type SettingsPageName = (typeof SETTINGS_PAGE_NAMES)[number];

/**
 * Opens one page of Settings (#290) from its list, as a tap does:
 * `/settings` first unless the list is already the screen, then the
 * page's row. Returns once the page's name is the screen's h1.
 */
export async function openSettings(page: Page, name: SettingsPageName): Promise<void> {
  if (new URL(page.url()).pathname !== '/settings') await page.goto('/settings');
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('link', { name, exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/[\w-]+$/);
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

/** The modules, as their switches in Settings, Modules name them. */
export type ModuleName = 'Projects' | 'Kitchen' | 'Reader' | 'Podcasts';

/**
 * Switches modules on in Settings, Modules (#290), from any screen, and
 * waits for the switches to be written. It never clicks a switch that
 * is, or is about to be, the way it is wanted: it waits for the modules
 * to be read (the switches draw off until then, and a click before can
 * be undone by the doc), switches the Reader first, and then waits for
 * Podcasts to follow it (#245) before deciding Podcasts needs a click,
 * since a click as it turns on can turn it off again.
 */
export async function switchModulesOn(page: Page, ...names: ModuleName[]): Promise<void> {
  await openSettings(page, 'Modules');
  await expect(page.getByRole('list', { name: 'Modules', exact: true })).not.toHaveAttribute(
    'aria-busy',
    'true',
    { timeout: 15_000 },
  );
  const toggle = (name: ModuleName) => page.getByRole('switch', { name, exact: true });
  const ordered = names.includes('Reader')
    ? (['Reader', ...names.filter((n) => n !== 'Reader')] as ModuleName[])
    : names;
  for (const name of ordered) {
    if (name === 'Podcasts' && (await toggle('Reader').isChecked())) {
      // Following the Reader: on by itself, unless it was switched off itself.
      const followed = await expect(toggle('Podcasts'))
        .toBeChecked({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (followed) continue;
    }
    if (!(await toggle(name).isChecked())) await toggle(name).click();
    await expect(toggle(name)).toBeChecked();
  }
  await letItSave(page);
}

/**
 * Kitchen's Meals or On hand as text (#288): Edit as text, in More,
 * shows the note's own editor in place of the week or the list.
 * Returns the editor.
 */
export async function editAsText(page: Page) {
  const menu = await openMore(page);
  await menu.getByRole('button', { name: 'Edit as text', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'New note' });
  await expect(editor).toBeVisible();
  return editor;
}

/**
 * Opens Previous note or Projects from More (since 2026-11-15, #287;
 * until then a pill under the note) and returns its list.
 */
export async function openFromMore(page: Page, name: 'Previous note' | 'Projects') {
  const menu = await openMore(page);
  await menu.getByRole('button', { name, exact: true }).click();
  const list = page.getByRole('list', {
    name: name === 'Projects' ? 'Projects' : 'Previous notes',
    exact: true,
  });
  await expect(list).toBeVisible();
  return list;
}

/**
 * Opens a project's folded items (#287): sub-projects, tasks and their
 * stage pickers, under one summary line that is closed by default.
 */
export async function openProjectHeader(page: Page): Promise<void> {
  const fold = page
    .getByRole('region', { name: 'Concept' })
    .locator('button[aria-controls="project-items"]');
  await expect(fold).toBeVisible({ timeout: 15_000 });
  if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
}

/**
 * Opens Right Now under a saved note on a phone (#287): one line there,
 * which opens the panel as a sheet. Returns the region.
 */
export async function openRightNow(page: Page) {
  const region = page.getByRole('region', { name: 'Right Now' });
  const line = region.locator('button[aria-controls="right-now-sheet"]');
  await expect(line).toBeVisible({ timeout: 15_000 });
  if ((await line.getAttribute('aria-expanded')) !== 'true') await line.click();
  await expect(line).toHaveAttribute('aria-expanded', 'true');
  return region;
}
