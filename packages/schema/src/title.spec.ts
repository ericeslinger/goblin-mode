import { describe, expect, it } from 'vitest';
import { firstWordsTitle } from './title';

describe('firstWordsTitle', () => {
  it('is empty for an empty or blank body', () => {
    expect(firstWordsTitle('')).toBe('');
    expect(firstWordsTitle('  \n\n ')).toBe('');
  });

  it('takes the first six words of the first non-empty line', () => {
    expect(firstWordsTitle('\nBuy a card for my nephew, he turns 9\nmore')).toBe(
      'Buy a card for my nephew,',
    );
  });

  it('drops markdown markers and wiki brackets', () => {
    expect(firstWordsTitle('## Sync with [[Vikas]]')).toBe('Sync with Vikas');
    expect(firstWordsTitle('- [ ] call the dentist')).toBe('call the dentist');
  });

  it('caps very long words with an ellipsis', () => {
    const title = firstWordsTitle('a'.repeat(100));
    expect(title).toHaveLength(60);
    expect(title.endsWith('…')).toBe(true);
  });
});
