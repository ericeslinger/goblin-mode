import { type Page, test as base, expect } from '@playwright/test';
import type { Persona } from './personas';

export const AUTH_EMULATOR = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9199';
const PROJECT = 'demo-mossgoblin';

/**
 * Keeps journeys off the network. Off-box requests are aborted, not
 * stubbed: Firebase Auth loads apis.google.com for its popup machinery
 * and waits forever on an empty stub, but carries on when it fails.
 */
export async function prepPage(page: Page): Promise<void> {
  await page.route(/fonts\.(googleapis|gstatic)\.com|apis\.google\.com/, (r) => r.abort());
}

export const FIRESTORE_EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';

/**
 * Wipes every Auth emulator account and all Firestore data, then creates
 * this persona under its fixed uid, so setup is retry-safe and every
 * journey starts empty. Journeys run serially (one worker), so a wipe is
 * safe.
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
 * launch screen. Resets the account first, so it is retry-safe; pass
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
  await page.waitForTimeout(800);
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await prepPage(page);
    await use(page);
  },
});

export { expect };

/** A JS value as the Firestore REST API writes it; Dates are timestamps. */
function restValue(v: unknown): object {
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(restValue) } };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: v } : { doubleValue: v };
  if (v && typeof v === 'object') return { mapValue: { fields: restFields(v) } };
  return { nullValue: null };
}
const restFields = (o: object) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, restValue(v)]));

/**
 * Writes a document as a function would, past the rules (Bearer owner),
 * for what only a function makes, such as the nightly suggestions.
 */
export async function seedDoc(path: string, data: object): Promise<void> {
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({ fields: restFields(data) }),
    },
  );
  if (!res.ok) throw new Error(`could not seed ${path}: ${await res.text()}`);
}
