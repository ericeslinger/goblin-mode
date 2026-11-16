import { describe, expect, it } from 'vitest';
import { visibleHtml } from './import';
import { escapeStrayLt, tagsOf } from './tag-scan';

/** The regex the scanner stands in for (visibleHtml's, before 2026-11-16). */
const TAG = /<(\/?)([a-z][a-z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/gi;

describe('tag-scan (review, 2026-11-16)', () => {
  it('finds exactly the tags the regex found, on pages made at random', () => {
    const pieces = [
      '<',
      '>',
      '/',
      '"',
      "'",
      'a',
      'B',
      '-',
      '_',
      '1',
      ' ',
      '=',
      '!',
      '\n',
      'div',
      'x-y',
    ];
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let round = 0; round < 2000; round++) {
      let html = '';
      const n = 1 + Math.floor(random() * 40);
      for (let i = 0; i < n; i++) html += pieces[Math.floor(random() * pieces.length)];
      const expected = [...html.matchAll(TAG)].map((m) => [m.index, m[0], m[1], m[2], m[3], m[4]]);
      const found = [...tagsOf(html)].map((t) => [
        t.start,
        html.slice(t.start, t.end),
        t.close ? '/' : '',
        t.name,
        t.attrs,
        t.selfClose ? '/' : '',
      ]);
      expect(found, html).toEqual(expected);
    }
  });

  it('reads a page of tags that never close in one pass', () => {
    const started = Date.now();
    for (const unit of ['<a ', '<a "', "<a '", '<!x ', '<div x="1" ']) {
      expect([...tagsOf(unit.repeat(200_000), { comments: true })]).toHaveLength(0);
      expect(visibleHtml(`<div hidden>${unit.repeat(200_000)}`)).toBe(' ');
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('writes a `<` that starts nothing as a word, and leaves tags and comments as they are', () => {
    expect(escapeStrayLt('a < b <3 <p class="x>y">c</p><!-- <z --><!doctype html> <a "')).toBe(
      'a &lt; b &lt;3 <p class="x>y">c</p><!-- <z --><!doctype html> &lt;a "',
    );
  });
});
