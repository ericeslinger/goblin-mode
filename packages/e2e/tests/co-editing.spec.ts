import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Safe co-editing (#37): Claude's line edits land on the current text,
// the open editor merges them into what Eric is typing, and edits made
// on both sides while the phone is offline are merged on the server.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

async function shoppingList(page: Page, call: (name: string, args: object) => Promise<unknown>) {
  await page.goto('/');
  await typeLines(page, ['Shopping list', '## Produce', '- [ ] apples']);
  await letItSave(page);
  const [found] = (await call('search_notes', { query: 'apples' })) as { id: string }[];
  return found.id;
}

test('typing goes on while Claude adds to the same list', async ({ page }) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  const id = await shoppingList(page, call);

  await note(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- [ ] bre');
  await call('add_lines', { id, heading: 'Produce', lines: ['- [ ] limes'] });
  await page.keyboard.type('ad');
  await expect(note(page)).toContainText('limes');
  await expect(note(page)).toContainText('bread');
  await letItSave(page);

  const saved = (await call('get_note', { id })) as { body: string };
  expect(saved.body).toContain('- [ ] limes');
  expect(saved.body).toContain('- [ ] bread');
  expect(saved.body).toContain('- [ ] apples');
});

test('edits made offline and Claude’s addition meanwhile are all kept', async ({
  page,
  request,
}) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page, request);
  const id = await shoppingList(page, call);

  await page.context().setOffline(true);
  // Off the apples line, it shows its checkbox.
  await page.keyboard.press('ControlOrMeta+Home');
  await note(page).locator('input.mg-checkbox').first().click();
  await expect(note(page).locator('input.mg-checkbox').first()).toBeChecked();
  await letItSave(page);
  // A second queued save, so the phone sends two writes when it is back.
  await page.keyboard.press('ControlOrMeta+End');
  // Enter continues the checklist.
  await typeLines(page, ['', 'bread']);
  await letItSave(page);
  await call('add_lines', { id, heading: 'Produce', lines: ['- [ ] oats'] });
  await page.context().setOffline(false);

  // The phone's writes land over Claude's; the server merges them.
  await expect(note(page)).toContainText('oats', { timeout: 15_000 });
  await expect
    .poll(async () => ((await call('get_note', { id })) as { body: string }).body, {
      timeout: 15_000,
    })
    .toBe('Shopping list\n## Produce\n- [x] apples\n- [ ] bread\n- [ ] oats');
});
