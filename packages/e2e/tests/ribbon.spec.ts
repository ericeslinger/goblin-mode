import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, openMore, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The editor ribbon (#77): on a touch screen, formatting buttons ride on
// top of the on-screen keyboard. A headless phone has no keyboard, so
// the visual viewport is made to leave room for one.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('the ribbon formats as you write: checklist, bold, lists and levels', async ({ page }) => {
  await page.addInitScript(() => {
    const vv = window.visualViewport;
    if (vv) Object.defineProperty(vv, 'height', { get: () => window.innerHeight - 300 });
  });
  await signInAs(page, OWNER);
  await note(page).click();
  const ribbon = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(ribbon).toBeVisible();
  // At a person's pace: a tap or an Enter lands before the next key.
  const settle = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  const tap = async (name: string) => {
    await ribbon.getByRole('button', { name, exact: true }).click();
    await settle();
  };
  const enter = async () => {
    await page.keyboard.press('Enter');
    await settle();
  };

  await page.keyboard.type('Groceries');
  await enter();
  await tap('Checklist item');
  await page.keyboard.type('milk ');
  await tap('Bold');
  await page.keyboard.type('fresh');
  await page.keyboard.press('End');
  await enter();
  await page.keyboard.type('eggs');
  await tap('Indent');
  await enter();
  await tap('Outdent');
  await page.keyboard.type('bread');
  await enter();
  await enter();
  await page.keyboard.type('Steps');
  await tap('Numbered list');
  await expect(ribbon.getByRole('button', { name: 'Italic', exact: true })).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  // Done stays in view on a narrow phone, though the row scrolls.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(ribbon.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
  await tap('Done');
  await expect(ribbon).toBeHidden();
  await letItSave(page);

  await (await openMore(page)).getByRole('button', { name: 'Source' }).click();
  await expect(note(page)).toHaveText(
    ['Groceries', '- [ ] milk *fresh*', '  - [ ] eggs', '- [ ] bread', '', '1. Steps'].join(''),
  );
});
