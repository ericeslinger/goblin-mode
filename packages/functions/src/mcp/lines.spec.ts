import { describe, expect, it } from 'vitest';
import { addLines, setItem } from './lines';

const list = [
  'Shopping list',
  '## Meal plan',
  'Tacos, then soup',
  '',
  '## Produce',
  '- [ ] apples',
  '',
  '## Dry goods',
  '',
].join('\n');

describe('addLines', () => {
  it('adds under a heading, after its last line, before the gap', () => {
    expect(addLines(list, ['- [ ] limes', '- [ ] onions'], 'produce')).toBe(
      list.replace('- [ ] apples', '- [ ] apples\n- [ ] limes\n- [ ] onions'),
    );
  });

  it('adds under an empty section straight after its heading', () => {
    expect(addLines(list, ['- [ ] rice'], '## Dry goods')).toBe(
      list.replace('## Dry goods', '## Dry goods\n- [ ] rice'),
    );
  });

  it('adds a heading the note lacks, at the end, and plain lines at the end', () => {
    expect(addLines(list, ['- [ ] chicken'], 'Butcher')).toBe(
      `${list.trimEnd()}\n\n## Butcher\n- [ ] chicken\n`,
    );
    expect(addLines('Note\nline\n\n', ['more'])).toBe('Note\nline\nmore\n\n');
    expect(addLines('', ['first'])).toBe('first\n');
  });

  it('keeps subsections inside their parent heading', () => {
    const body = '# Trip\n## Pack\n- socks\n# After';
    expect(addLines(body, ['- map'], 'Trip')).toBe('# Trip\n## Pack\n- socks\n- map\n# After');
  });
});

describe('setItem', () => {
  const body = '- [ ] apples\n- [x] green apples\n* [ ] Oat milk\nnot an item';

  it('ticks and unticks the item named, leaving every other character', () => {
    expect(setItem(body, 'oat MILK', true)).toEqual({
      body: body.replace('* [ ] Oat milk', '* [x] Oat milk'),
      text: 'Oat milk',
      changed: true,
    });
    expect(setItem(body, 'green apples', false)).toMatchObject({
      body: body.replace('- [x] green apples', '- [ ] green apples'),
      changed: true,
    });
  });

  it('matches exactly first, then the only item containing the words', () => {
    expect(setItem(body, 'apples', true)).toMatchObject({ text: 'apples', changed: true });
    expect(setItem(body, 'oat', true)).toMatchObject({ text: 'Oat milk' });
  });

  it('says so when already done, ambiguous or missing', () => {
    expect(setItem(body, 'green apples', true)).toMatchObject({ changed: false });
    expect(setItem('- [ ] red pen\n- [ ] blue pen', 'pen', true)).toMatch(/several items/);
    expect(setItem(body, 'bread', true)).toMatch(/no item matches "bread"; the items are: apples/);
    expect(setItem('just text', 'x', true)).toBe('the note has no checklist items');
  });
});
