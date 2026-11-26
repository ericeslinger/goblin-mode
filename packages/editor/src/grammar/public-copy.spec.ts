import { describe, expect, it } from 'vitest';
import { publicCopy } from './public-copy';

describe('publicCopy', () => {
  it('writes wiki links as their words, a label over the name', () => {
    expect(publicCopy('Fired with [[Vik]] at [[Kiln log|the kiln]].')).toBe(
      'Fired with Vik at the kiln.',
    );
  });

  it('keeps the words of a name that holds markdown’s marks as words', () => {
    expect(publicCopy('See [[2 * 3]] and [[a_b_c]] and [[x|a [y]]')).toBe(
      'See 2 \\* 3 and a\\_b\\_c and [[x|a [y]]',
    );
  });

  it('keeps tags, checkboxes, emphasis, links and headings as written', () => {
    const body =
      '# Glaze\n\n#pottery *bold* _it_\n\n- [ ] buy clay\n- [x] fire\n\n[site](https://x.example)';
    expect(publicCopy(body)).toBe(body);
  });

  it('drops the assistant’s @goblin mark, keeping the item', () => {
    expect(publicCopy('- [ ] find a cone 6 glaze @goblin\n- [x] done @GOBLIN  ')).toBe(
      '- [ ] find a cone 6 glaze\n- [x] done  ',
    );
    // Not at the end of a checkbox item: words.
    expect(publicCopy('ask @goblin later')).toBe('ask @goblin later');
  });

  it('drops a line saying why the assistant could not do an item, keeps its findings', () => {
    const body = [
      '- [x] cone 6 glazes',
      '  - ✳ Mossgoblin, from the web:',
      '    - Try Floating Blue',
      '- [ ] another @goblin',
      '  - ✳ Mossgoblin: could not reach the web just now',
    ].join('\n');
    expect(publicCopy(body)).toBe(
      [
        '- [x] cone 6 glazes',
        '  - ✳ Mossgoblin, from the web:',
        '    - Try Floating Blue',
        '- [ ] another',
      ].join('\n'),
    );
  });

  it('drops attached images, which part 2 will share; a web image stays', () => {
    expect(publicCopy('Pots: ![kiln.jpg](attachment:a1) ![x](https://img.example/x.png)')).toBe(
      'Pots:  ![x](https://img.example/x.png)',
    );
  });

  it('leaves code exactly as it is', () => {
    const body = 'Use `[[x]]` for links.\n\n```\n[[Vik]] @goblin\n```';
    expect(publicCopy(body)).toBe(body);
  });

  it('is empty for an empty body', () => {
    expect(publicCopy('')).toBe('');
  });

  it('reads any nesting without running out of stack (review of #343)', () => {
    const deep = `${'> '.repeat(5_000)}[[Vik]] deep`;
    const out = publicCopy(deep);
    expect(out.endsWith('Vik deep')).toBe(true);
    const list = Array.from({ length: 300 }, (_, i) => `${'  '.repeat(i)}- [[n${i}]]`).join('\n');
    expect(publicCopy(list)).toContain('- n299');
  });
});
