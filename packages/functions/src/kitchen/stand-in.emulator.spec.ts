import { describe, expect, it } from 'vitest';
import { standInRecipePages, standInRecipeReader } from './stand-in.emulator';

// The emulator build's recipe stand-ins (2026-11-14): a site that
// refuses, and a scripted reader, under the functions emulator only.
const EMULATOR = { FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8180' };
const at = { url: 'https://refused.invalid/potatoes', title: '' };

describe('the recipe stand-ins (emulator build)', () => {
  it('refuses refused.invalid as a licensing site does', async () => {
    await expect(standInRecipePages(EMULATOR)!('https://refused.invalid/potatoes')).rejects.toThrow(
      'this site does not let Mossgoblin read its pages (it answered 402)',
    );
  });

  it('reads a plainly written recipe, and nothing else', async () => {
    const read = standInRecipeReader(EMULATOR)!;
    const text = 'Potatoes\nIngredients\n2 potatoes\nMethod\nSlice.\nBake.\nNotes\nGood.';
    await expect(read({ ...at, text })).resolves.toEqual({
      name: 'Potatoes',
      ingredients: ['2 potatoes'],
      method: ['Slice.', 'Bake.'],
    });
    await expect(read({ ...at, text: 'Terms of use' })).resolves.toBeUndefined();
  });

  it('answers nothing off the emulator', () => {
    expect(standInRecipePages({})).toBeUndefined();
    expect(standInRecipeReader({ FUNCTIONS_EMULATOR: 'true' })).toBeUndefined();
  });
});
