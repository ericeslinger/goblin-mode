import { describe, expect, it } from 'vitest';
import { FINDINGS_MARK, answerItem, assignedItems, findingsLines } from './assigned';

const NOTE = [
  'Presents',
  '',
  '- [ ] research good Xmas presents for my nephews @goblin',
  '- [ ] wrap them',
  '  - [ ] find the best glaze for celadon @Goblin ',
  '- [x] book the kiln @goblin',
].join('\n');

describe('assigned items (#144 step 4)', () => {
  it('finds the items ending in @goblin, ticked or not, with the mention off', () => {
    expect(assignedItems(NOTE)).toEqual([
      {
        line: 2,
        text: 'research good Xmas presents for my nephews',
        key: 'research good xmas presents for my nephews',
        done: false,
      },
      {
        line: 4,
        text: 'find the best glaze for celadon',
        key: 'find the best glaze for celadon',
        done: false,
      },
      { line: 5, text: 'book the kiln', key: 'book the kiln', done: true },
    ]);
    expect(assignedItems('- [ ] @goblin\n- [ ] email goblin@example.com')).toEqual([]);
  });

  it('writes the answer under the item, one level in, and ticks it', () => {
    const lines = findingsLines('- Lego, from https://a.example\nA book, from https://b.example');
    expect(lines).toEqual([
      `- ${FINDINGS_MARK}`,
      '  - Lego, from https://a.example',
      '  - A book, from https://b.example',
    ]);
    const out = answerItem(NOTE, 'find the best glaze for celadon', lines);
    expect(out.changed).toBe(true);
    expect(out.body.split('\n').slice(4, 9)).toEqual([
      '  - [x] find the best glaze for celadon @Goblin ',
      `    - ${FINDINGS_MARK}`,
      '      - Lego, from https://a.example',
      '      - A book, from https://b.example',
      '- [x] book the kiln @goblin',
    ]);
    // Not ticked: a line saying why it could not be done.
    const said = answerItem(NOTE, 'book the kiln', ['- ✳ Mossgoblin: no key'], false);
    expect(said.changed).toBe(false);
    const open = answerItem(NOTE, 'research good xmas presents for my nephews', ['- x'], false);
    expect(open.body.split('\n')[2]).toBe(
      '- [ ] research good Xmas presents for my nephews @goblin',
    );
    expect(open.body.split('\n')[3]).toBe('  - x');
    expect(answerItem(NOTE, 'nothing like this', lines).changed).toBe(false);
  });

  it('keeps findings to their length', () => {
    const long = findingsLines('x'.repeat(5000));
    expect(long[1].length).toBeLessThan(2100);
  });
});
