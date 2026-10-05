import { type Page, test as base, expect } from '@playwright/test';
import type { Persona } from './personas';

export const AUTH_EMULATOR = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9199';
const PROJECT = 'demo-goblin-mode';

/**
 * Keeps journeys off the network. Off-box requests are aborted, not
 * stubbed: Firebase Auth loads apis.google.com for its popup machinery
 * and waits forever on an empty stub, but carries on when it fails.
 */
export async function prepPage(page: Page): Promise<void> {
  await page.route(/fonts\.(googleapis|gstatic)\.com|apis\.google\.com/, (r) => r.abort());
}

/**
 * Wipes every Auth emulator account and creates this one, so setup is
 * retry-safe. Journeys run serially (one worker), so a wipe is safe.
 */
export async function resetAccount(email: string, password: string): Promise<void> {
  const base = `http://${AUTH_EMULATOR}`;
  const wiped = await fetch(`${base}/emulator/v1/projects/${PROJECT}/accounts`, {
    method: 'DELETE',
  });
  if (!wiped.ok) throw new Error(`could not wipe accounts: ${await wiped.text()}`);
  const created = await fetch(
    `${base}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=e2e-fake-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!created.ok) throw new Error(`could not create ${email}: ${await created.text()}`);
}

/**
 * Signs in through the emulator-only /dev-sign-in page and waits for the
 * launch screen. Resets the account first, so it is retry-safe.
 */
export async function signInAs(page: Page, persona: Persona): Promise<void> {
  await resetAccount(persona.email, persona.password);
  await page.goto('/dev-sign-in');
  await page.getByLabel('Email').fill(persona.email);
  await page.getByLabel('Password').fill(persona.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeVisible();
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await prepPage(page);
    await use(page);
  },
});

export { expect };
