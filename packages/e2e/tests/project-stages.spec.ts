import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Stages and items (Eric, 2026-10-17): a project lists the stages its
// items move through and the tags they carry; each pot is a project
// under pottery, a row with a stage to pick. The settings and Linked
// from are on the back of the note (#112), so the page keeps its room.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('pots move through pottery’s stages', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Glaze shelf', 'Lovers vase is on the [[Pottery]] glaze shelf', 'ok']);
  await letItSave(page);
  await note(page).getByRole('link', { name: 'Pottery', exact: true }).click();
  await expect(page).toHaveURL(/\/n\/c-pottery$/);
  const concept = page.getByRole('region', { name: 'Concept' });
  await concept.getByRole('combobox', { name: 'Type' }).selectOption('project');

  // On the back until asked for.
  await expect(concept.getByRole('combobox', { name: 'Parent' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Linked from' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Linked from' })).toContainText('Glaze shelf');

  for (const stage of ['plan', 'thrown', 'bisque']) {
    await concept.getByRole('textbox', { name: 'Add a stage' }).fill(stage);
    await concept.getByRole('textbox', { name: 'Add a stage' }).press('Enter');
    await expect(concept.getByRole('list', { name: 'Stages' })).toContainText(stage);
  }
  await concept.getByRole('textbox', { name: 'Add an item tag' }).fill('gift');
  await concept.getByRole('textbox', { name: 'Add an item tag' }).press('Enter');
  await expect(concept.getByRole('list', { name: 'Item tags' })).toContainText('gift');
  await page.getByRole('button', { name: 'Front', exact: true }).click();

  for (const pot of ['Lovers vase', 'Wounded pot']) {
    await concept.getByRole('textbox', { name: 'Add a project in Pottery' }).fill(pot);
    await concept.getByRole('textbox', { name: 'Add a project in Pottery' }).press('Enter');
  }
  const pots = concept.getByRole('list', { name: 'Projects in Pottery' });
  await expect(pots.getByRole('listitem')).toHaveText([/Lovers vase/, /Wounded pot/]);
  await concept.getByRole('combobox', { name: 'Stage of Wounded pot' }).selectOption('plan');
  await concept.getByRole('combobox', { name: 'Stage of Lovers vase' }).selectOption('bisque');
  // Stage order: plan before bisque.
  await expect(pots.getByRole('listitem')).toHaveText([/Wounded pot/, /Lovers vase/]);
  await concept.getByRole('button', { name: 'Tag Lovers vase' }).click();
  await concept.getByRole('button', { name: 'gift on Lovers vase' }).click();
  await expect(concept.getByRole('button', { name: 'gift on Lovers vase' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Kept: after a reload, and on the pot's own page.
  await letItSave(page);
  await page.reload();
  await expect(concept.getByRole('combobox', { name: 'Stage of Lovers vase' })).toHaveValue(
    'bisque',
  );
  await pots.getByRole('link', { name: 'Lovers vase' }).click();
  await expect(page).toHaveURL(/\/n\/c-lovers-vase$/);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(concept.getByRole('combobox', { name: 'Parent' })).toHaveValue('c-pottery');
});
