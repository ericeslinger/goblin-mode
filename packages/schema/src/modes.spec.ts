import { describe, expect, it } from 'vitest';
import { MODES, MODE_IDS, effectiveMode, modeBrief, takesInstructions } from './modes';

describe('modeBrief', () => {
  it('joins the preset and the note’s own instructions, the preset first', () => {
    const brief = modeBrief('log', 'Mention the weather.');
    expect(brief).toBe(
      `Takes new material as a log: ${MODES.log.preset}\n\nInstructions for Claude: Mention the weather.`,
    );
  });

  it('says only what there is', () => {
    expect(modeBrief('list', undefined)).toBe(`Takes new material as a list: ${MODES.list.preset}`);
    expect(modeBrief(undefined, '  Keep it short. ')).toBe(
      'Instructions for Claude: Keep it short.',
    );
    expect(modeBrief(undefined, '')).toBe('');
  });

  it('words each preset as #231 asks', () => {
    expect(MODE_IDS).toEqual(['list', 'log', 'synthesis']);
    expect(MODES.list.preset).toMatch(/never a duplicate/);
    expect(MODES.list.preset).toMatch(/Never drop or reword an unticked item/);
    expect(MODES.log.preset).toMatch(/today’s date, newest last/);
    expect(MODES.log.preset).toMatch(/Never rewrite earlier entries/);
    expect(MODES.synthesis.preset).toMatch(/keep both and say which is newer/);
    expect(MODES.synthesis.preset).toMatch(/nothing is dropped without a line saying so/);
  });
});

describe('takesInstructions', () => {
  it('is plain notes, concepts, templates and clippings only', () => {
    for (const kind of ['text', 'concept', 'template', 'clipping', undefined])
      expect(takesInstructions(kind)).toBe(true);
    for (const kind of ['sketch', 'recipe', 'mealplan', 'pantry', 'context'])
      expect(takesInstructions(kind)).toBe(false);
  });
});

describe('effectiveMode', () => {
  const template = {
    id: 't1',
    kind: 'template',
    templateMode: 'living',
    body: 'Groceries\n## Produce',
    mode: 'list',
    instructions: 'Group by aisle.',
  };
  const living = { id: 'n1', kind: 'text', fromTemplate: 't1', body: '## Produce' };

  it('is the note’s own mode and instructions', () => {
    expect(effectiveMode({ kind: 'text', mode: 'log', instructions: ' Dated. ' })).toEqual({
      mode: 'log',
      instructions: 'Dated.',
      inherited: false,
    });
    expect(effectiveMode({ kind: 'text' })).toBeUndefined();
    expect(effectiveMode({ kind: 'text', mode: 'shouty' })).toBeUndefined();
  });

  it('gives a living note its template’s, unless it sets its own', () => {
    expect(effectiveMode(living, template)).toEqual({
      mode: 'list',
      instructions: 'Group by aisle.',
      inherited: true,
    });
    expect(effectiveMode({ ...living, mode: 'synthesis' }, template)).toEqual({
      mode: 'synthesis',
      instructions: 'Group by aisle.',
      inherited: true,
    });
    expect(
      effectiveMode({ ...living, mode: 'synthesis', instructions: 'Mine.' }, template),
    ).toEqual({ mode: 'synthesis', instructions: 'Mine.', inherited: false });
  });

  it('inherits nothing from an entry template or another template', () => {
    expect(effectiveMode(living, { ...template, templateMode: 'entry' })).toBeUndefined();
    expect(effectiveMode(living, { ...template, id: 't2' })).toBeUndefined();
    expect(effectiveMode({ ...living, fromTemplate: undefined }, template)).toBeUndefined();
  });

  it('reads a template’s old instructions section, and ignores kinds without', () => {
    expect(
      effectiveMode({ kind: 'template', body: 'Log\n## Instructions for Claude\nBe brief.' }),
    ).toEqual({ instructions: 'Be brief.', inherited: false });
    expect(effectiveMode({ kind: 'recipe', mode: 'log', instructions: 'x' })).toBeUndefined();
  });
});
