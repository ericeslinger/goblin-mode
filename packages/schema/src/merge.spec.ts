import { describe, expect, it } from 'vitest';
import { MAX_TABLE, merge3, textHash } from './merge';

const list = (...lines: string[]) => lines.join('\n');
const base = list(
  'Shopping list',
  '## Produce',
  '- [ ] apples',
  '- [ ] kale',
  '## Dry goods',
  '- [ ] rice',
);

describe('merge3', () => {
  it('keeps a tick on one side and an added item on the other', () => {
    const ticked = base.replace('- [ ] apples', '- [x] apples');
    const added = base.replace('- [ ] rice', '- [ ] rice\n- [ ] oats');
    expect(merge3(base, ticked, added)).toBe(
      list(
        'Shopping list',
        '## Produce',
        '- [x] apples',
        '- [ ] kale',
        '## Dry goods',
        '- [ ] rice',
        '- [ ] oats',
      ),
    );
    expect(merge3(base, added, ticked)).toBe(merge3(base, ticked, added));
  });

  it('takes the same change once', () => {
    const ticked = base.replace('- [ ] kale', '- [x] kale');
    expect(merge3(base, ticked, ticked)).toBe(ticked);
  });

  it('keeps both when both changed the same line, ours first', () => {
    const ours = base.replace('- [ ] apples', '- [x] apples');
    const theirs = base.replace('- [ ] apples', '- [ ] green apples');
    expect(merge3(base, ours, theirs)).toBe(
      list(
        'Shopping list',
        '## Produce',
        '- [x] apples',
        '- [ ] green apples',
        '- [ ] kale',
        '## Dry goods',
        '- [ ] rice',
      ),
    );
  });

  it('keeps a tick and an item added right after it, without repeating the line', () => {
    const b = list('Shopping list', '## Produce', '- [ ] apples');
    const ticked = list('Shopping list', '## Produce', '- [x] apples');
    const added = list('Shopping list', '## Produce', '- [ ] apples', '- [ ] oats');
    const both = list('Shopping list', '## Produce', '- [x] apples', '- [ ] oats');
    expect(merge3(b, ticked, added)).toBe(both);
    expect(merge3(b, added, ticked)).toBe(both);
    // And an item added right before an edited line.
    expect(merge3('a\nb', 'a\nB', 'a\nnew\nb')).toBe('a\nnew\nB');
  });

  it('takes a line both sides added beside an edit once (2026-10-07)', () => {
    // A stale save added a line; the newer text fixed the lines above
    // and added the same one.
    expect(merge3('a\nb', 'a\nb\nnew', 'A\nB\nnew')).toBe('A\nB\nnew');
    expect(merge3('a\nb', 'a\nb\nnew', 'A\nB')).toBe('A\nB\nnew');
    expect(merge3('a\nb', 'top\na\nb', 'top\nA\nb')).toBe('top\nA\nb');
  });

  it('keeps typing at the end and lines added elsewhere', () => {
    const ours = `${base}\n- [ ] bre`;
    const theirs = base.replace('## Produce', '## Produce\n- [ ] leeks');
    expect(merge3(base, ours, theirs)).toBe(
      list(
        'Shopping list',
        '## Produce',
        '- [ ] leeks',
        '- [ ] apples',
        '- [ ] kale',
        '## Dry goods',
        '- [ ] rice',
        '- [ ] bre',
      ),
    );
  });

  it('keeps both sides’ new lines in the same place, without repeats', () => {
    expect(merge3('a', 'a\nb\nc', 'a\nc\nd')).toBe('a\nb\nc\nd');
  });

  it('keeps a repeated line one side added even when the other has one', () => {
    expect(merge3('a\nz', 'a\nb\n---\nz', 'a\nc\n---\n---\nz')).toBe('a\nb\n---\nc\n---\nz');
  });

  it('keeps both sides of a rewrite too large to compare line by line', () => {
    const n = Math.ceil(Math.sqrt(MAX_TABLE)) + 2;
    const lines = (p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`).join('\n');
    const merged = merge3(
      `top\n${lines('b')}\nend`,
      `top\n${lines('o')}\nend`,
      `top\n${lines('t')}\nend`,
    );
    expect(merged.startsWith(`top\n${lines('o')}\n${lines('t')}`)).toBe(true);
    expect(merged.endsWith('\nend')).toBe(true);
  });

  it('takes one side whole when the other did not change', () => {
    expect(merge3(base, base, 'x')).toBe('x');
    expect(merge3(base, 'y', base)).toBe('y');
    expect(merge3('', '', 'Claude wrote this')).toBe('Claude wrote this');
  });

  it('keeps a deletion on one side', () => {
    const ours = base.replace('- [ ] kale\n', '');
    const theirs = base.replace('- [ ] rice', '- [x] rice');
    expect(merge3(base, ours, theirs)).toBe(
      list('Shopping list', '## Produce', '- [ ] apples', '## Dry goods', '- [x] rice'),
    );
  });
});

describe('textHash', () => {
  it('is stable, short, and tells texts apart', () => {
    expect(textHash('- [ ] apples')).toBe(textHash('- [ ] apples'));
    expect(textHash('- [ ] apples')).not.toBe(textHash('- [x] apples'));
    expect(textHash('')).toMatch(/^0-[0-9a-f]{8}$/);
  });
});
