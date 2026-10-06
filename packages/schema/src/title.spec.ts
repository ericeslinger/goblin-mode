import { describe, expect, it } from 'vitest';
import { cleanTitle, firstLine, firstWordsTitle, wantsClaudeTitle } from './title';

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

describe('firstLine', () => {
  it('is the first non-empty line, trimmed', () => {
    expect(firstLine('\n  call the bank about the loan \nmore')).toBe(
      'call the bank about the loan',
    );
    expect(firstLine('  \n')).toBe('');
  });
});

describe('wantsClaudeTitle', () => {
  const body = 'call the bank about the loan';

  it('asks when a note is settled', () => {
    expect(wantsClaudeTitle(undefined, { body, settledAt: 5 })).toBe(true);
    expect(wantsClaudeTitle({ settledAt: 1 }, { body, settledAt: 5 })).toBe(true);
  });

  it('skips writes that do not settle it, short notes, and titles Eric set', () => {
    expect(wantsClaudeTitle({ settledAt: 5 }, { body, settledAt: 5 })).toBe(false);
    expect(wantsClaudeTitle(undefined, { body })).toBe(false);
    expect(wantsClaudeTitle(undefined, { body: 'milk eggs', settledAt: 5 })).toBe(false);
    expect(wantsClaudeTitle(undefined, { body, titleSource: 'user', settledAt: 5 })).toBe(false);
  });
});

describe('cleanTitle', () => {
  it('takes one line without quotes, a label or a trailing period', () => {
    expect(cleanTitle('"Bank loan call."\n')).toBe('Bank loan call');
    expect(cleanTitle('Title: Loan rates')).toBe('Loan rates');
    expect(cleanTitle('x'.repeat(80))).toHaveLength(60);
  });
});
