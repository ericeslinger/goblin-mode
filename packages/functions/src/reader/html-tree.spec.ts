import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  attr,
  descendants,
  innerHtml,
  elementBound,
  outerHtml,
  parseTree,
  textOf,
} from './html-tree';

describe('html-tree (2026-11-16)', () => {
  it('finds a nested element whole, where a lazy match ends at the first close', () => {
    const html = '<div class="body"><div>one</div><p>two</p></div><div class="after">three</div>';
    const tree = parseTree(html);
    const body = tree.children[0];
    expect(innerHtml(html, body)).toBe('<div>one</div><p>two</p>');
    expect(tree.children.map((el) => attr(el.tag, 'class'))).toEqual(['body', 'after']);
  });

  it('skips void elements, comments and script bodies, and ignores a stray close', () => {
    const html =
      '<p>a<br>b<img src="x.png"></p><!-- <div> --></span><script>if (a < b) "</div>"</script><div>c</div>';
    const tree = parseTree(html);
    expect(tree.children.map((el) => el.name)).toEqual(['p', 'script', 'div']);
    expect(tree.children[0].children.map((el) => el.name)).toEqual(['br', 'img']);
    expect(innerHtml(html, tree.children[2])).toBe('c');
  });

  it('closes what was left open inside an element with it, and a <p> at the next block', () => {
    const html = '<div><p>one<p>two<ul><li>a<li>b</ul></div><p>three';
    const tree = parseTree(html);
    const div = tree.children[0];
    expect(div.children.map((el) => el.name)).toEqual(['p', 'p', 'ul']);
    expect(outerHtml(html, div.children[0])).toBe('<p>one');
    expect(div.children[2].children.map((el) => innerHtml(html, el))).toEqual(['a', 'b']);
    expect(innerHtml(html, tree.children[1])).toBe('three');
    expect(descendants(tree)).toHaveLength(7);
  });

  it('bounds the elements a page can make, a self-closing tag counted, and walks a deep page', () => {
    expect(elementBound('<div><p>a<p>b</div><img><br>').count).toBe(5);
    expect(elementBound('<div/><div/> a < b <3 </div>').count).toBe(2);
    expect(elementBound('<a><b><c><d>', 2)).toEqual({ count: 3, at: 6 });
    const deep = `${'<div>'.repeat(30_000)}x${'</div>'.repeat(30_000)}`;
    expect(descendants(parseTree(deep))).toHaveLength(30_000);
  });

  it('reads attributes and words, and splices edits, an edit inside a dropped one skipped', () => {
    expect(attr('<a HREF="/x?a=1&amp;b=2" data-x=\'y\'>', 'href')).toBe('/x?a=1&b=2');
    expect(attr('<a data-x=y>', 'data-x')).toBe('y');
    expect(textOf('<p>One &amp; <b>two</b></p><style>.x{}</style>')).toBe('One & two');
    expect(
      applyEdits('abcdefgh', [
        { start: 1, end: 5, text: '-' },
        { start: 2, end: 3, text: 'X' },
        { start: 6, end: 7, text: '+' },
      ]),
    ).toBe('a-f+h');
  });
});
