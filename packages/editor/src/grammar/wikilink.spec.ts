import { describe, expect, it } from 'vitest';
import type { WikiLink } from './wikilink';
import { findWikiLinks, pointAt } from './wikilink';
import { parseNote } from './parse';

function links(text: string): WikiLink[] {
  const found: WikiLink[] = [];
  const walk = (node: { type: string; children?: unknown[] }) => {
    if (node.type === 'wikiLink') found.push(node as unknown as WikiLink);
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(parseNote(text) as unknown as { type: string; children: unknown[] });
  return found;
}

describe('findWikiLinks', () => {
  it('finds targets and aliases with offsets', () => {
    expect(findWikiLinks('see [[Vikas]] and [[Project Hotswap|Hotswap]]')).toEqual([
      { start: 4, end: 13, target: 'Vikas' },
      { start: 18, end: 45, target: 'Project Hotswap', alias: 'Hotswap' },
    ]);
  });

  it('ignores empty, nested and multi-line brackets', () => {
    expect(findWikiLinks('[[ ]] [[a[b]]] [[line\nbreak]]')).toEqual([]);
  });
});

describe('remarkWikiLinks', () => {
  it('splits wiki links out of text with exact source positions', () => {
    const text = 'Met with [[Vikas]] today';
    const [link] = links(text);
    expect(link).toMatchObject({ type: 'wikiLink', target: 'Vikas' });
    expect(text.slice(link.position!.start.offset, link.position!.end.offset)).toBe('[[Vikas]]');
  });

  it('keeps offsets exact on later lines and inside list items', () => {
    const text = '# Notes\n\n- [ ] call [[Vikas|vik]] back\n- second';
    const [link] = links(text);
    expect(link.alias).toBe('vik');
    expect(link.position!.start.line).toBe(3);
    expect(text.slice(link.position!.start.offset, link.position!.end.offset)).toBe(
      '[[Vikas|vik]]',
    );
  });

  it('maps offsets past escapes in the same text', () => {
    const text = '\\* see [[Vikas]]';
    const [link] = links(text);
    expect(text.slice(link.position!.start.offset, link.position!.end.offset)).toBe('[[Vikas]]');
  });

  it('finds links on indented continuation lines', () => {
    const text = '- first line\n  then [[Vikas]] here';
    const [link] = links(text);
    expect(link?.target).toBe('Vikas');
    expect(text.slice(link.position!.start.offset, link.position!.end.offset)).toBe('[[Vikas]]');
  });

  it('finds an aliased link in a table cell when its pipe is escaped', () => {
    const text = '| who |\n| --- |\n| [[Vikas\\|vik]] |';
    const [link] = links(text);
    expect(link).toMatchObject({ target: 'Vikas', alias: 'vik' });
    expect(text.slice(link.position!.start.offset, link.position!.end.offset)).toBe(
      '[[Vikas\\|vik]]',
    );
  });

  it('does not find links inside code', () => {
    expect(links('`[[not a link]]`\n\n    [[nor this]]')).toEqual([]);
  });
});

describe('pointAt', () => {
  it('gives 1-based lines and columns', () => {
    expect(pointAt('ab\ncd', 4)).toEqual({ line: 2, column: 2, offset: 4 });
    expect(pointAt('ab\ncd', 0)).toEqual({ line: 1, column: 1, offset: 0 });
  });
});
