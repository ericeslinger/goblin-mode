import { folderChips } from './reader-bar';

describe('the folder chips (#288)', () => {
  const folders = [{ name: 'Tech' }, { name: 'Games' }, { name: 'Uncategorized' }];
  const counts = { all: 179, saved: 2, Tech: 74, Games: 43, Uncategorized: 62 };

  it('lists All, then each folder in the Reader’s order, with its unread count', () => {
    expect(folderChips(folders, counts, 'all').map((c) => [c.name, c.count])).toEqual([
      ['All', 179],
      ['Tech', 74],
      ['Games', 43],
      ['Uncategorized', 62],
    ]);
  });

  it('links each to the list the Folders tab leads to, All to the Reader', () => {
    expect(folderChips(folders, counts, 'all').map((c) => c.link)).toEqual([
      '/reader',
      ['/reader/f', 'Tech'],
      ['/reader/f', 'Games'],
      ['/reader/f', 'Uncategorized'],
    ]);
  });

  it('marks the shelf shown, and counts a folder with nothing unread as 0', () => {
    const chips = folderChips(folders, { all: 74, Tech: 74 }, 'Games');
    expect(chips.filter((c) => c.current).map((c) => c.name)).toEqual(['Games']);
    expect(chips.find((c) => c.name === 'Games')!.count).toBe(0);
    expect(folderChips(folders, counts, 'all').filter((c) => c.current)).toHaveLength(1);
  });

  it('is All alone with no folders', () => {
    expect(folderChips([], {}, 'all')).toEqual([
      { name: 'All', link: '/reader', count: 0, current: true },
    ]);
  });
});
