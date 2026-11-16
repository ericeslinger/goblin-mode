import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { editAsText, expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Kitchen in the layout pass, step 4 (#288): one Kitchen header over
// the four tabs, the tabs never moving between them; Meals is the week,
// drawn once, its text behind Edit as text; the week between its
// neighbours on one row, today marked in words; the recipe book
// searched, sorted, added to in place, and "made" only where it was;
// On hand without its empty headings, every section still offered to
// add to. On the phone of the design report.

test.use({ viewport: { width: 412, height: 839 } });

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function kitchenOn(page: Page): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Kitchen' }).check();
  await letItSave(page);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Kitchen' })).toBeChecked();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 16", as the app writes a day. */
const shortDate = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** The week a plan's URL names. */
const planStart = (page: Page) => /\/n\/meals-(\d{4}-\d{2}-\d{2})$/.exec(page.url())![1];

test('one Kitchen header, its tabs in the same place on every tab', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  await kitchenOn(page);

  const tabs: [url: string, lands: RegExp, tab: RegExp][] = [
    ['/kitchen', /\/n\/meals-\d{4}-\d{2}-\d{2}$/, /^Meals/],
    ['/kitchen/shopping', /\/kitchen\/shopping$/, /^Shopping/],
    ['/kitchen/recipes', /\/kitchen\/recipes$/, /^Recipes/],
    ['/kitchen/pantry', /\/n\/pantry$/, /^On hand/],
  ];
  const at: { header: number; tabs: number; left: number; width: number }[] = [];
  for (const [url, lands, tab] of tabs) {
    await page.goto(url);
    await expect(page).toHaveURL(lands, { timeout: 15_000 });
    // The tab's own screen is drawn, not the one leading to it.
    if (url === '/kitchen') {
      await expect(page.getByRole('region', { name: 'Meal plan' })).toBeVisible();
    }
    if (url === '/kitchen/pantry') {
      await expect(page.getByRole('region', { name: 'On hand' })).toBeVisible();
    }
    const nav = page.getByRole('navigation', { name: 'Kitchen screens' });
    await expect(nav).toHaveCount(1);
    await expect(nav.getByRole('link', { name: tab })).toHaveAttribute('aria-current', 'page');
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveText('Kitchen');
    await expect(h1).toHaveCount(1);
    const header = page.locator('app-page-header header');
    await expect(header).toHaveCount(1);
    await expect(header.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    // The note bar is not drawn over the plan or the pantry.
    await expect(page.locator('header.bar')).toHaveCount(0);
    const [head, bar] = [(await header.boundingBox())!, (await nav.boundingBox())!];
    at.push({ header: head.y, tabs: bar.y, left: bar.x, width: bar.width });
    await noSeriousViolations(page);
  }
  for (const [i, place] of at.entries()) {
    const what = `${tabs[i][0]} against /kitchen`;
    expect(Math.abs(place.header - at[0].header), what).toBeLessThanOrEqual(1);
    expect(Math.abs(place.tabs - at[0].tabs), what).toBeLessThanOrEqual(1);
    expect(Math.abs(place.left - at[0].left), what).toBeLessThanOrEqual(1);
    expect(Math.abs(place.width - at[0].width), what).toBeLessThanOrEqual(1);
  }

  // On Meals and On hand the note's own controls are the header's
  // actions, by the names they had in the note bar.
  for (const url of ['/kitchen', '/kitchen/pantry']) {
    await page.goto(url);
    await expect(page).toHaveURL(/\/n\//, { timeout: 15_000 });
    const header = page.locator('app-page-header header');
    await expect(header.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: 'More' })).toBeVisible();
    await header.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Back of the note' })).toBeVisible();
    await header.getByRole('button', { name: 'Front', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Back of the note' })).toHaveCount(0);
  }
});

test('Meals shows each day once, its text behind Edit as text', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await kitchenOn(page);

  await page.goto('/kitchen/2026-10-21');
  await expect(page).toHaveURL(/\/n\/meals-2026-10-19$/);
  const plan = page.getByRole('region', { name: 'Meal plan' });
  await expect(plan.getByRole('list', { name: 'Meals' }).getByRole('listitem')).toHaveCount(7);
  // No second copy: the plan's text is not drawn under the week.
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeHidden();
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    await expect(page.getByText(`${day} dinner`).filter({ visible: true })).toHaveCount(1);
  }
  // Nothing the week cannot draw, so no block for it.
  await expect(plan.getByRole('heading', { name: 'Also in this plan' })).toHaveCount(0);

  // A note under a dinner shows under it in the week.
  await plan.getByRole('button', { name: 'Change Tue dinner, Oct 20: nothing planned' }).click();
  await plan.getByRole('button', { name: 'Delivery' }).click();
  await plan.getByRole('checkbox', { name: 'Made Tue dinner, Oct 20' }).check();
  await plan.getByRole('textbox', { name: 'What was it, and from where?' }).fill('dandan noodles');
  await plan.getByRole('button', { name: 'Save' }).click();
  await expect(plan.getByText('dandan noodles', { exact: true })).toBeVisible();
  await letItSave(page);

  // Edit as text: the plain editor with the plan's text; typing there
  // is saved, and what the week cannot draw shows under it.
  const editor = await editAsText(page);
  await expect(plan).toHaveCount(0);
  await expect(editor).toContainText('Tue dinner: delivery');
  await expect(editor).toContainText('dandan noodles');
  // Focused, not clicked: a tap could land on a slot's box in the text.
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Bread from the market');
  await letItSave(page);
  await page.getByRole('button', { name: 'Show the week', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeHidden();
  const also = plan.getByRole('list', { name: 'Also in this plan' });
  await expect(also).toHaveText('Bread from the market');
  await expect(plan.getByText('dandan noodles', { exact: true })).toBeVisible();
  await expect
    .poll(
      async () => ((await call('get_note', { id: 'meals-2026-10-19' })) as { body: string }).body,
      { timeout: 15_000 },
    )
    .toContain('Bread from the market');
  // A plan opens on its week again.
  await page.reload();
  await expect(also).toHaveText('Bread from the market', { timeout: 15_000 });
  await noSeriousViolations(page);

  // A line with no words to show is counted, never shown nowhere
  // (2026-11-16): an image with no alt text.
  await letItSave(page);
  await call('add_lines', { id: 'meals-2026-10-19', lines: ['![](https://example.com/a.png)'] });
  await expect(plan.getByText('1 more line without words')).toBeVisible({ timeout: 15_000 });
  await expect(also).toHaveText('Bread from the market');
});

test('the week switcher is one row, moves a week each way, and marks today', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  await kitchenOn(page);

  await page.goto('/kitchen');
  await expect(page).toHaveURL(/\/n\/meals-\d{4}-\d{2}-\d{2}$/, { timeout: 15_000 });
  const start = planStart(page);
  const plan = page.getByRole('region', { name: 'Meal plan' });
  const weeks = plan.getByRole('navigation', { name: 'Weeks' });
  const previous = weeks.getByRole('link', { name: 'Previous week' });
  const next = weeks.getByRole('link', { name: 'Next week' });
  const name = weeks.getByRole('heading', { level: 2 });
  await expect(name).toHaveText(`Week of ${shortDate(start)}`);
  // One row: the two steps and the name share a centre line, and each
  // step is a 44 px target.
  const [p, n, w] = [
    (await previous.boundingBox())!,
    (await next.boundingBox())!,
    (await name.boundingBox())!,
  ];
  const centre = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(centre(p) - centre(w))).toBeLessThanOrEqual(2);
  expect(Math.abs(centre(n) - centre(w))).toBeLessThanOrEqual(2);
  expect(p.x + p.width).toBeLessThanOrEqual(w.x + 0.5);
  expect(w.x + w.width).toBeLessThanOrEqual(n.x + 0.5);
  for (const b of [p, n]) {
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
  // The grocery list and On hand on one line under it.
  const [list, onHand] = [
    (await plan.getByRole('button', { name: 'Make the grocery list' }).boundingBox())!,
    (await plan.getByRole('button', { name: 'On hand', exact: true }).boundingBox())!,
  ];
  expect(Math.abs(list.y - onHand.y)).toBeLessThanOrEqual(1);
  expect(list.y).toBeGreaterThan(w.y);

  // Today is tinted and says so in words.
  const today = await page.evaluate(() => {
    const d = new Date();
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const marked = plan.locator('li[aria-current="date"]');
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText(`dinner, ${shortDate(today)}`);
  await expect(marked).toContainText('Today');
  expect(await marked.evaluate((li) => getComputedStyle(li).backgroundColor)).not.toBe(
    'rgba(0, 0, 0, 0)',
  );
  await noSeriousViolations(page);

  await next.click();
  await expect(page).toHaveURL(new RegExp(`/n/meals-${addDays(start, 7)}$`));
  await expect(name).toHaveText(`Week of ${shortDate(addDays(start, 7))}`);
  await expect(marked).toHaveCount(0);
  await previous.click();
  await expect(page).toHaveURL(new RegExp(`/n/meals-${start}$`));
  await previous.click();
  await expect(page).toHaveURL(new RegExp(`/n/meals-${addDays(start, -7)}$`));
  await expect(name).toHaveText(`Week of ${shortDate(addDays(start, -7))}`);
});

test('Recipes is searched, sorted and added to, made said only of one made', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await kitchenOn(page);
  for (const name of ['Shakshuka', 'Dal', 'Miso cod']) {
    await call('create_recipe', { name, ingredients: ['salt'], method: ['Cook.'] });
  }
  // Shakshuka made on Oct 19: the week opened here first, so Claude's
  // plan and the app's are the same note.
  await page.goto('/kitchen/2026-10-19');
  await expect(page).toHaveURL(/\/n\/meals-2026-10-19$/);
  await letItSave(page);
  await call('plan_meal', { date: '2026-10-19', slot: '[[Shakshuka]]' });
  const plan = page.getByRole('region', { name: 'Meal plan' });
  await expect(
    plan.getByRole('button', { name: 'Change Mon dinner, Oct 19: Shakshuka' }),
  ).toBeVisible({ timeout: 15_000 });
  await plan.getByRole('checkbox', { name: 'Made Mon dinner, Oct 19' }).check();
  await letItSave(page);

  await page.goto('/kitchen/recipes');
  const book = page.getByRole('list', { name: 'Recipes' });
  await expect(book.getByRole('link')).toHaveText([/^Dal/, /^Miso cod/, /^Shakshuka/], {
    timeout: 15_000,
  });
  await expect(book.getByRole('link', { name: /^Shakshuka/ })).toContainText(
    'made 1×, last Oct 19',
  );
  await expect(book.getByRole('link', { name: /^Dal/ })).toHaveText('Dal');
  await expect(book.getByRole('link', { name: /^Miso cod/ })).toHaveText('Miso cod');
  const lately = page.getByRole('button', { name: 'Made lately' });
  await lately.click();
  await expect(lately).toHaveAttribute('aria-pressed', 'true');
  await expect(book.getByRole('link')).toHaveText([/^Shakshuka/, /^Dal/, /^Miso cod/]);
  await page.getByRole('button', { name: 'A to Z' }).click();

  // The search narrows as it is typed.
  const search = page.getByRole('searchbox', { name: 'Search recipes' });
  await search.fill('mis');
  await expect(book.getByRole('link')).toHaveText([/^Miso cod/]);
  await search.fill('');
  await expect(book.getByRole('link')).toHaveCount(3);
  await noSeriousViolations(page);

  // Add recipe makes one here, as Browse's New recipe does.
  await page.getByRole('button', { name: 'Add recipe' }).click();
  await page.getByRole('textbox', { name: 'Name of the new recipe' }).fill('Aloo gobi');
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(page).toHaveURL(/\/n\/[\w-]+$/);
  await letItSave(page);
  await page.goto('/kitchen/recipes');
  await expect(book.getByRole('link')).toHaveText(
    [/^Aloo gobi/, /^Dal/, /^Miso cod/, /^Shakshuka/],
    { timeout: 15_000 },
  );
  await expect(book.getByRole('link', { name: /^Aloo gobi/ })).toHaveText('Aloo gobi');
});

test('On hand hides an empty heading, and adding to it still works', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await kitchenOn(page);

  await page.goto('/kitchen/pantry');
  await expect(page).toHaveURL(/\/n\/pantry$/, { timeout: 15_000 });
  const onHand = page.getByRole('region', { name: 'On hand' });
  // Made with the store's sections, all empty: none is shown.
  await expect(onHand).toContainText('Nothing on hand yet');
  await expect(onHand.getByRole('heading')).toHaveCount(0);
  await letItSave(page);
  await call('update_pantry', { add: [{ item: 'rice', section: 'Dry goods' }] });
  await expect(onHand.getByRole('heading', { name: 'Dry goods' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(onHand.getByRole('list', { name: 'Dry goods' })).toContainText('rice');
  await expect(onHand.getByRole('heading', { name: 'Produce' })).toHaveCount(0);
  await expect(onHand.getByRole('heading', { name: 'Butcher' })).toHaveCount(0);
  await noSeriousViolations(page);

  // Add to offers every section, the hidden ones too.
  const to = onHand.getByRole('combobox', { name: 'Add to' });
  await expect(to.locator('option')).toHaveText(['Produce', 'Butcher', 'Dry goods', 'Other']);
  await onHand.getByRole('textbox', { name: 'New item' }).fill('limes');
  await to.selectOption('Produce');
  await onHand.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(onHand.getByRole('status')).toHaveText('Added limes to Produce.');
  await expect(onHand.getByRole('heading', { name: 'Produce' })).toBeVisible();
  await expect(onHand.getByRole('list', { name: 'Produce' })).toContainText('limes');
  await expect(onHand.getByRole('heading', { name: 'Butcher' })).toHaveCount(0);
  await letItSave(page);
  await expect
    .poll(
      async () =>
        ((await call('get_pantry', {})) as { items: { item: string; section: string }[] }).items,
      { timeout: 15_000 },
    )
    .toContainEqual(expect.objectContaining({ item: 'limes', section: 'Produce' }));

  // The text keeps every heading, empty or not.
  const editor = await editAsText(page);
  await expect(editor).toContainText('Butcher');
  await expect(editor).toContainText('limes');
  await page.getByRole('button', { name: 'Show the list', exact: true }).click();
  await expect(onHand.getByRole('heading', { name: 'Butcher' })).toHaveCount(0);
  await noSeriousViolations(page);

  // A heading holding only a line that is not an item shows, with that
  // line under it (2026-11-16).
  await letItSave(page);
  await call('add_lines', { id: 'pantry', heading: 'Freezer', lines: ['- [ ] defrost bread'] });
  await expect(onHand.getByRole('heading', { name: 'Freezer' })).toBeVisible({ timeout: 15_000 });
  await expect(onHand.getByRole('list', { name: 'Freezer' })).toHaveText('defrost bread');
  await expect(onHand.getByRole('heading', { name: 'Butcher' })).toHaveCount(0);
});
