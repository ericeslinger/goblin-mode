import { FISH_ID } from '@mossgoblin/schema';
import {
  pantrySections,
  readPlan,
  recipeRows,
  shownSections,
  weekLabel,
  wordlessLine,
} from './kitchen-lines';

const START = '2026-11-16';

/** The lines of a note that are not blank, by index. */
const written = (body: string) =>
  body
    .split('\n')
    .map((l, i) => (l.trim() ? i : -1))
    .filter((i) => i >= 0);

/** Each index once, or the test fails: no line drawn twice, none lost. */
function accounted(parts: number[][]): number[] {
  const all = parts.flat();
  expect(new Set(all).size).toBe(all.length);
  return [...all].sort((a, b) => a - b);
}

describe('Kitchen reading views (#288)', () => {
  it('names a week by its first day', () => {
    expect(weekLabel('2026-11-16')).toBe('Week of Nov 16');
    expect(weekLabel('2026-01-05')).toBe('Week of Jan 5');
  });

  it('says how many lines have no words, one or more', () => {
    expect(wordlessLine(0)).toBe('');
    expect(wordlessLine(1)).toBe('1 more line without words');
    expect(wordlessLine(3)).toBe('3 more lines without words');
  });

  it('finds no extra lines in a plan as it is made, notes under a dinner included', () => {
    const body =
      '## Week of Nov 16\n\n- [ ] Mon dinner: [[Dal]]\n  - more lemon\n  - with rice\n' +
      '- [x] Tue dinner: delivery\n';
    expect(readPlan(body, START)).toEqual({
      heading: 0,
      drawn: [2, 3, 4, 5],
      extras: [],
      wordless: [],
    });
    // The old name as a first line is the week's own too.
    expect(readPlan('Meals, week of Nov 16\n- [ ] Mon dinner:\n', START).extras).toEqual([]);
  });

  it('takes only the first line, naming this week, as the week’s heading', () => {
    const words = (body: string) => readPlan(body, START).extras.map((x) => x.words);
    // Another week's heading, a free "Week of" line, and this week's
    // heading when it is not the first line: each shows.
    expect(words('## Week of Nov 23\n- [ ] Mon dinner:\n')).toEqual(['Week of Nov 23']);
    expect(words('## Week of Nov 16\n- [ ] Mon dinner:\nWeek of Dec 1\n')).toEqual([
      'Week of Dec 1',
    ]);
    expect(words('Guests Friday\n## Week of Nov 16\n')).toEqual([
      'Guests Friday',
      'Week of Nov 16',
    ]);
    expect(words('## Week of Nov 16\n## Week of Nov 16\n')).toEqual(['Week of Nov 16']);
  });

  it('keeps every line the week cannot draw, as plain words, and counts the wordless', () => {
    const body = [
      'Guests on *Friday*',
      '## Week of Nov 16',
      '- [ ] Mon dinner:',
      '',
      '  - a note after a gap is not under the dinner',
      '- [ ] Someday: [[Paella]]',
      '## Ideas',
      '---',
      '![](https://example.com/a.png)',
    ].join('\n');
    const reading = readPlan(body, START);
    expect(reading.extras.map((x) => x.words)).toEqual([
      'Guests on Friday',
      'Week of Nov 16',
      'a note after a gap is not under the dinner',
      'Someday: Paella',
      'Ideas',
    ]);
    expect(reading.wordless).toEqual([7, 8]);
  });

  it('shows every line of a plan with no first day under Also in this plan', () => {
    const body = '## Week of Nov 16\n- [ ] Mon dinner: [[Dal]]\n  - more lemon\n';
    expect(readPlan(body, '')).toEqual({
      drawn: [],
      extras: [
        { line: 0, words: 'Week of Nov 16' },
        { line: 1, words: 'Mon dinner: Dal' },
        { line: 2, words: 'more lemon' },
      ],
      wordless: [],
    });
  });

  // Every line that is not blank is drawn, shown as words or counted
  // (2026-11-16): never shown nowhere.
  const AWKWARD_PLANS: [name: string, body: string, start: string][] = [
    ['as made', '## Week of Nov 16\n\n- [ ] Mon dinner:\n- [ ] Tue dinner:\n', START],
    [
      'notes, nested and parted by a blank line',
      '- [ ] Mon dinner: [[Dal]]\n  - lemon\n    - more\n\n  - parted\n- [x] Tue dinner: out\n',
      START,
    ],
    ['a checklist', '- [ ] Mon dinner:\n- [ ] buy bread\n- [x] call Ma\n', START],
    ['a link', 'See [the menu](https://example.com/menu)\n- [ ] Mon dinner:\n', START],
    ['a code block', '```\nrice 2:1\n```\n- [ ] Mon dinner:\n', START],
    ['a second heading', '## Week of Nov 16\n- [ ] Mon dinner:\n## Week of Nov 23\n', START],
    ['a free week line', 'Week of Dec 1\n- [ ] Mon dinner:\n', START],
    ['wordless lines', '---\n![](https://example.com/a.png)\n- [ ] Mon dinner:\n***\n', START],
    ['no first day', '## Week of Nov 16\n- [ ] Mon dinner:\n  - lemon\n---\n', ''],
  ];
  it.each(AWKWARD_PLANS)('accounts for every line of a plan: %s', (_name, body, start) => {
    const r = readPlan(body, start);
    const heading = r.heading === undefined ? [] : [r.heading];
    expect(accounted([heading, r.drawn, r.extras.map((x) => x.line), r.wordless])).toEqual(
      written(body),
    );
  });

  it('reads the pantry by section, every heading kept, the empty ones hidden', () => {
    const body = '## Produce\n\n## Butcher\n\n## Dry goods\n- rice\n- salt: always\n';
    const all = pantrySections(body);
    expect(all.map((s) => s.heading)).toEqual(['', 'Produce', 'Butcher', 'Dry goods']);
    const shown = shownSections(all);
    expect(shown.map((s) => s.heading)).toEqual(['Dry goods']);
    expect(shown[0].items.map((i) => [i.item, i.always])).toEqual([
      ['rice', false],
      ['salt', true],
    ]);
    expect(shown[0].extras).toEqual([]);
  });

  it('keeps a heading holding only lines that are not items, with those lines', () => {
    const body =
      'On hand\n- lemons: 3\n- [ ] buy more rice\n## Freezer\n- [ ] defrost bread\n' +
      '## Produce\n- onions\nAsk at the market\n## Rules\n---\n## Empty\n';
    const shown = shownSections(pantrySections(body));
    expect(
      shown.map((s) => [s.heading, s.items.length, s.extras.map((x) => x.words), s.wordless]),
    ).toEqual([
      ['', 1, ['On hand', 'buy more rice'], []],
      ['Freezer', 0, ['defrost bread'], []],
      ['Produce', 1, ['Ask at the market'], []],
      ['Rules', 0, [], [9]],
    ]);
  });

  const AWKWARD_PANTRIES: [name: string, body: string][] = [
    ['as made', '## Produce\n\n## Butcher\n\n## Dry goods\n'],
    ['a heading of checkboxes', '## Freezer\n- [ ] defrost bread\n- [x] ice\n'],
    ['nested bullets', '## Produce\n- onions\n  - red ones\n    - small\n'],
    ['a title and a link', 'On hand\nSee [the shop](https://example.com)\n- rice\n'],
    ['a code block', '## Notes\n```\nrice: 2 cups\n```\n'],
    ['wordless lines', '## Produce\n![](https://example.com/a.png)\n---\n- limes\n'],
    ['a second heading of the same name', '## Produce\n- limes\n## Produce\n- onions\n'],
  ];
  it.each(AWKWARD_PANTRIES)('accounts for every line of the pantry: %s', (_name, body) => {
    const sections = pantrySections(body);
    // A heading is drawn when anything is under it, and offered in Add
    // to whatever: either way it is not shown nowhere.
    const headings = sections.flatMap((s) => (s.line === undefined ? [] : [s.line]));
    expect(
      accounted([
        headings,
        sections.flatMap((s) => s.items.map((i) => i.line)),
        sections.flatMap((s) => s.extras.map((x) => x.line)),
        sections.flatMap((s) => s.wordless),
      ]),
    ).toEqual(written(body));
  });

  describe('the recipe book', () => {
    const recipe = (id: string, title: string, archived = false) => ({
      id,
      title,
      kind: 'recipe',
      archived,
    });
    const notes = [
      recipe('s', 'Shakshuka'),
      recipe('d', 'dal'),
      recipe('m', 'Miso cod'),
      recipe('old', 'Old soup', true),
      recipe(FISH_ID, 'Fish of the week'),
      { id: 'n', title: 'Shopping', kind: 'note' },
    ];
    const made = new Map([
      ['shakshuka', ['2026-10-19', '2026-11-02', '2026-11-09']],
      ['miso cod', ['2026-11-12']],
    ]);

    it('sorts by name, A to Z, saying made only for one that was', () => {
      const rows = recipeRows(notes, made, '', 'name');
      expect(rows.map((r) => r.title)).toEqual(['dal', 'Miso cod', 'Shakshuka']);
      expect(rows.map((r) => r.made)).toEqual(['', 'made 1×, last Nov 12', 'made 3×, last Nov 9']);
    });

    it('sorts the most lately made first, then the never made by name', () => {
      const rows = recipeRows([...notes, recipe('a', 'Aloo gobi')], made, '', 'made');
      expect(rows.map((r) => r.title)).toEqual(['Miso cod', 'Shakshuka', 'Aloo gobi', 'dal']);
    });

    it('narrows by name as typed, in any case', () => {
      expect(recipeRows(notes, made, 'SHA', 'name').map((r) => r.id)).toEqual(['s']);
      expect(recipeRows(notes, made, '  o ', 'name').map((r) => r.id)).toEqual(['m']);
      expect(recipeRows(notes, made, 'paella', 'name')).toEqual([]);
    });
  });
});
