import { describe, expect, it } from 'vitest';
import { templateParts } from './templates';

describe('templateParts', () => {
  it('splits the instructions section from the skeleton', () => {
    const body = [
      'Shopping list',
      '## Produce',
      '## Butcher',
      '## Instructions for Claude',
      'Start from the meal plan.',
      'Group items under the headings.',
      '## Dry goods',
    ].join('\n');
    expect(templateParts(body)).toEqual({
      skeleton: 'Shopping list\n## Produce\n## Butcher\n\n## Dry goods',
      instructions: 'Start from the meal plan.\nGroup items under the headings.',
    });
  });

  it('runs to the end, keeps deeper headings inside, and ignores case and level', () => {
    const body = 'Journal\n\n# instructions for claude\nAsk about mood.\n### Tone\nGentle.';
    expect(templateParts(body)).toEqual({
      skeleton: 'Journal',
      instructions: 'Ask about mood.\n### Tone\nGentle.',
    });
  });

  it('leaves a body with no such heading whole', () => {
    expect(templateParts('Packing list\n- socks\n')).toEqual({
      skeleton: 'Packing list\n- socks',
      instructions: '',
    });
    // Mentioned in text, not as a heading, it is not the section.
    expect(templateParts('Instructions for Claude are below').instructions).toBe('');
  });
});
