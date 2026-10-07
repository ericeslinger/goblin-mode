import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, openMore, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The editor ribbon (#77): on a touch screen, formatting buttons ride on
// top of the on-screen keyboard. A headless phone has no keyboard, so
// one is faked the way Android Chrome reports it under
// interactive-widget=overlays-content: neither viewport shrinks, and
// only navigator.virtualKeyboard says a keyboard is up (2026-10-07; an
// earlier fake shrank the visual viewport, which Android never does
// here, and passed while the ribbon never showed on a real phone).

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

const fakeKeyboard = (page: Page) =>
  page.addInitScript(() => {
    const vk = Object.defineProperties(new EventTarget(), {
      overlaysContent: { value: false, writable: true },
      boundingRect: {
        get() {
          const typing = document.activeElement?.getAttribute('contenteditable') === 'true';
          const h = typing ? 300 : 0;
          return new DOMRect(0, window.innerHeight - h, window.innerWidth, h);
        },
      },
    });
    Object.defineProperty(navigator, 'virtualKeyboard', { value: vk });
    const changed = () => setTimeout(() => vk.dispatchEvent(new Event('geometrychange')));
    document.addEventListener('focusin', changed);
    document.addEventListener('focusout', changed);
  });

test('the ribbon formats as you write: checklist, bold, lists and levels', async ({ page }) => {
  await fakeKeyboard(page);
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

test('the line being typed stays above the keyboard and the ribbon in a long note', async ({
  page,
}) => {
  // Both overlay the page (2026-10-07: the ribbon sat on the line).
  await fakeKeyboard(page);
  await signInAs(page, OWNER);
  await note(page).click();
  const ribbon = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(ribbon).toBeVisible();
  const settle = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  for (let i = 0; i < 40; i++) {
    await page.keyboard.type(`line ${i}`);
    await page.keyboard.press('Enter');
    await settle();
  }
  await page.keyboard.type('the last line');
  await settle();
  await expect(page.locator('.cm-line')).toHaveCount(41);
  const line = (await page.locator('.cm-line', { hasText: 'the last line' }).boundingBox())!;
  const bar = (await ribbon.boundingBox())!;
  const keyboardTop = await page.evaluate(() => window.innerHeight - 300);
  expect(bar.y + bar.height).toBeLessThanOrEqual(keyboardTop + 1);
  expect(line.y + line.height).toBeLessThanOrEqual(bar.y + 1);
});
