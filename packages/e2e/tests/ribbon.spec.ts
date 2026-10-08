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
  const button = (name: string) => ribbon.getByRole('button', { name, exact: true });
  const tap = async (name: string) => {
    await button(name).click();
    await settle();
  };
  // A hold on a group's button offers its other choices (2026-10-08).
  const hold = async (name: string, menu: string, choice: string) => {
    await button(name).click({ delay: 700 });
    const choices = page.getByRole('menu', { name: menu });
    await expect(choices).toBeVisible();
    await choices.getByRole('menuitemradio', { name: choice }).click();
    await expect(choices).toBeHidden();
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
  await page.keyboard.type('bread ');
  await hold('Bold', 'Style', 'Italic');
  await page.keyboard.type('soon');
  await page.keyboard.press('End');
  // The choice sticks: the button is Italic now, and Bold is in its menu.
  await expect(button('Italic')).toBeVisible();
  await expect(button('Bold')).toHaveCount(0);
  await enter();
  await enter();
  await page.keyboard.type('Steps');
  await hold('Checklist item', 'Lists', 'Numbered list');
  await expect(button('Numbered list')).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  // Six buttons fit a narrow phone without scrolling, Hide keyboard last.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(button('Hide keyboard')).toBeInViewport();
  expect(await ribbon.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // A drag along the row presses nothing (2026-10-08: it pressed the
  // button the drag started on).
  const box = (await button('Indent').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await settle();
  await tap('Hide keyboard');
  await expect(ribbon).toBeHidden();
  await letItSave(page);

  await (await openMore(page)).getByRole('button', { name: 'Source' }).click();
  await expect(note(page)).toHaveText(
    ['Groceries', '- [ ] milk *fresh*', '  - [ ] eggs', '- [ ] bread _soon_', '', '1. Steps'].join(
      '',
    ),
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
