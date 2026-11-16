import { FISH_ID } from '@mossgoblin/schema';
import {
  pantryExtras,
  pantrySections,
  planExtras,
  recipeRows,
  shownSections,
  weekLabel,
} from './kitchen-lines';

const START = '2026-11-16';

describe('Kitchen reading views (#288)', () => {
  it('names a week by its first day', () => {
    expect(weekLabel('2026-11-16')).toBe('Week of Nov 16');
    expect(weekLabel('2026-01-05')).toBe('Week of Jan 5');
  });

  it('finds no extra lines in a plan as it is made, notes under a dinner included', () => {
    const body =
      '## Week of Nov 16\n\n- [ ] Mon dinner: [[Dal]]\n  - more lemon\n  - with rice\n' +
      '- [x] Tue dinner: delivery\n';
    expect(planExtras(body, START)).toEqual([]);
    // The old name as a first line is the week's own too.
    expect(planExtras('Meals, week of Nov 16\n- [ ] Mon dinner:\n', START)).toEqual([]);
  });

  it('keeps every line the week cannot draw, as plain words', () => {
    const body = [
      'Guests on *Friday*',
      '## Week of Nov 16',
      '- [ ] Mon dinner:',
      '',
      '  - a note after a gap is not under the dinner',
      '- [ ] Someday: [[Paella]]',
      '## Ideas',
      '---',
    ].join('\n');
    expect(planExtras(body, START)).toEqual([
      'Guests on Friday',
      'a note after a gap is not under the dinner',
      'Someday: Paella',
      'Ideas',
    ]);
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
    expect(pantryExtras(body)).toEqual([]);
  });

  it('shows items before any heading, and lines that are not items', () => {
    const body =
      'On hand\n- lemons: 3\n- [ ] buy more rice\n## Produce\n- onions\nAsk at the market\n';
    expect(shownSections(pantrySections(body)).map((s) => [s.heading, s.items.length])).toEqual([
      ['', 1],
      ['Produce', 1],
    ]);
    expect(pantryExtras(body)).toEqual(['buy more rice', 'Ask at the market']);
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
