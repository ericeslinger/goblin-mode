import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, openCapture, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The layout pass, step 1 (#285): nothing widens the phone's page,
// snippets read as plain words, and what is taller than its room
// scrolls in its own box instead of painting over Right Now.

/** A 300-character address with nowhere to break. */
const ADDRESS = `https://example.com/${'a'.repeat(280)}`;

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** How an element scrolls: its sizes and its computed overflow-y. */
const scrolling = (el: Element) => ({
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
  overflowY: getComputedStyle(el).overflowY,
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 839 } });

  test('a long image address wraps in Browse instead of widening the page', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    // One under its title, one as its first line, so the title wraps too.
    await call('create_note', { body: `Clipped bowl\n![](${ADDRESS})\nCeladon over the bisque.` });
    await call('create_note', { body: `![](${ADDRESS})\nA picture first.` });

    await page.goto('/browse');
    const notes = page.getByRole('list', { name: 'Notes' });
    const clipped = notes.getByRole('link', { name: /Clipped bowl/ });
    await expect(clipped).toBeVisible({ timeout: 15_000 });
    await expect(notes.getByRole('link', { name: /A picture first/ })).toBeVisible({
      timeout: 15_000,
    });
    const snippet = clipped.locator('.snippet');
    await expect(snippet).toHaveText('Celadon over the bisque.');
    expect(await snippet.textContent()).not.toMatch(/\]\(|http/);

    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
  });

  test('a Browse row shows plain words, not the marks typed', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_note', {
      body: 'Glaze plans\nAsk [[Some name]] about the *bold* celadon, _gently_',
    });

    await page.goto('/browse');
    const row = page
      .getByRole('list', { name: 'Notes' })
      .getByRole('link', { name: /Glaze plans/ });
    await expect(row.locator('.snippet')).toHaveText(
      'Ask Some name about the bold celadon, gently',
      { timeout: 15_000 },
    );
  });

  test('an open Projects list scrolls in its own box above Right Now', async ({ page }) => {
    test.setTimeout(90_000);
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    // Eric's garden has 19 projects: more than the room above Right Now.
    for (let i = 1; i <= 19; i++) {
      await call('create_concept', {
        name: `Project ${String(i).padStart(2, '0')}`,
        type: 'project',
      });
    }
    // Something due, so Right Now is open at its usual share.
    await call('create_reminder', {
      text: 'Call the bank',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await openCapture(page);
    const handle = page.getByRole('separator', { name: 'Resize Right Now' });
    await expect(handle).toHaveAttribute('aria-valuenow', '35', { timeout: 15_000 });
    const pill = page.getByRole('button', { name: 'Projects', exact: true });
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await pill.click();
    const list = page.getByRole('list', { name: 'Projects' });
    await expect(list.getByRole('listitem')).toHaveCount(19, { timeout: 15_000 });

    const rightNow = page.getByRole('region', { name: 'Right Now' });
    const listBox = (await list.boundingBox())!;
    const panelBox = (await rightNow.boundingBox())!;
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(panelBox.y + 1);
    const box = await list.evaluate(scrolling);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(['auto', 'scroll']).toContain(box.overflowY);
    // The note keeps room of its own while the list is open.
    expect((await page.locator('app-note-editor').boundingBox())!.height).toBeGreaterThan(100);

    // The last project is reached by scrolling the list, and opens.
    const last = list.getByRole('button', { name: /Project 19/ });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await noSeriousViolations(page);
    await last.click();
    await expect(page).toHaveURL(/\/n\/c-project-19$/);
  });
});

test.describe('on a wide screen', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test('Right Now beside the notes scrolls inside its cap, its heading in sight', async ({
    page,
  }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    // Long reminders, so the three shown are taller than the cap.
    const long = 'ring about the kiln shelves, the cone packs and the glaze order '.repeat(3);
    for (const n of [1, 2, 3, 4]) {
      await call('create_reminder', {
        text: `Reminder ${n}: ${long.trim()}`,
        dueAt: new Date(Date.now() - n * 60_000).toISOString(),
      });
    }

    await openCapture(page);
    const rightNow = page.getByRole('region', { name: 'Right Now' });
    await expect(rightNow.getByRole('button', { name: /^Done: Reminder/ })).toHaveCount(3, {
      timeout: 15_000,
    });
    const box = await rightNow.evaluate(scrolling);
    // Capped (40% of the height, and its padding) well short of the
    // window, it scrolls rather than clips.
    expect(box.clientHeight).toBeLessThan(900 * 0.5);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(['auto', 'scroll']).toContain(box.overflowY);

    // Scrolled to its end, the heading is still at its top.
    await rightNow.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const heading = rightNow.getByRole('heading', { name: 'Right Now' });
    await expect
      .poll(async () => {
        const [h, r] = [(await heading.boundingBox())!, (await rightNow.boundingBox())!];
        return Math.abs(h.y - r.y);
      })
      .toBeLessThanOrEqual(1);
    await expect(rightNow.getByRole('link', { name: '1 more' })).toBeInViewport();
    await noSeriousViolations(page);
  });
});
