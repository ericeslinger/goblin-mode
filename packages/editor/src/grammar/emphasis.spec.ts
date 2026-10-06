import type { Nodes } from 'mdast';
import { describe, expect, it } from 'vitest';
import { parseNote } from './parse';
import { renderNoteHtml } from './render';

/** Each inline node's type and its source text, depth first. */
function marks(text: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: Nodes) => {
    if (node.type === 'strong' || node.type === 'emphasis') {
      out.push([node.type, text.slice(node.position!.start.offset, node.position!.end.offset)]);
    }
    if ('children' in node) node.children.forEach((c) => walk(c as Nodes));
  };
  walk(parseNote(text));
  return out;
}

describe('emphasis', () => {
  it('reads one star as bold, underscores as italic, and two stars as bold', () => {
    expect(marks('a *bold* b')).toEqual([['strong', '*bold*']]);
    expect(marks('a _italic_ b')).toEqual([['emphasis', '_italic_']]);
    expect(marks('a **bold** b')).toEqual([['strong', '**bold**']]);
    expect(marks('a __bold__ b')).toEqual([['strong', '__bold__']]);
  });

  it('nests: bold with italic inside, and italic with bold inside', () => {
    expect(marks('*bold _and italic_*')).toEqual([
      ['strong', '*bold _and italic_*'],
      ['emphasis', '_and italic_'],
    ]);
    expect(marks('_italic *and bold*_')).toEqual([
      ['emphasis', '_italic *and bold*_'],
      ['strong', '*and bold*'],
    ]);
  });

  it('reads three stars as bold only, since every star means bold; *_x_* is both', () => {
    expect(marks('***x***').map(([type]) => type)).toEqual(['strong', 'strong']);
    expect(marks('*_x_*')).toEqual([
      ['strong', '*_x_*'],
      ['emphasis', '_x_'],
    ]);
  });

  it('leaves list bullets, literal stars and code alone', () => {
    expect(marks('* item\n* item')).toEqual([]);
    expect(marks('2 * 3 * 4')).toEqual([]);
    expect(marks('`*not bold*`')).toEqual([]);
  });

  it('renders the same way to HTML', () => {
    expect(renderNoteHtml('*bold* and _italic_')).toBe(
      '<p><strong>bold</strong> and <em>italic</em></p>',
    );
  });
});
