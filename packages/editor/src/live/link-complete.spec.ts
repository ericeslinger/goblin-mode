import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hooksFacet } from './hooks';
import { linkCompletions } from './link-complete';

const suggestions = [
  { name: 'Pottery', kind: 'project' },
  { name: 'pott', kind: 'new' },
];

function contextAt(doc: string, suggest = vi.fn(() => suggestions)) {
  const state = EditorState.create({ doc, extensions: [hooksFacet.of({ suggestLinks: suggest })] });
  return { context: new CompletionContext(state, doc.length, false), suggest };
}

let view: EditorView | undefined;
afterEach(() => view?.destroy());

describe('linkCompletions', () => {
  it('offers the host’s names for an open link, from just after `[[`', () => {
    const { context, suggest } = contextAt('ask [[pott');
    const result = linkCompletions(context)!;
    expect(suggest).toHaveBeenCalledWith('pott');
    expect(result.from).toBe(6);
    expect(result.options.map((o) => [o.label, o.detail])).toEqual([
      ['Pottery', 'project'],
      ['pott', 'new concept'],
    ]);
  });

  it('stays quiet outside a link, or a link already past its alias bar', () => {
    expect(linkCompletions(contextAt('no link here').context)).toBeNull();
    expect(linkCompletions(contextAt('[[a|b').context)).toBeNull();
    expect(linkCompletions(contextAt('[[done]] after').context)).toBeNull();
  });

  it('writes the name and closes the link, reusing a closing `]]`', () => {
    for (const [doc, cursor, expected] of [
      ['ask [[pott', 10, 'ask [[Pottery]]'],
      ['ask [[pott]] now', 10, 'ask [[Pottery]] now'],
    ] as const) {
      view = new EditorView({
        state: EditorState.create({ doc, selection: { anchor: cursor } }),
        parent: document.body,
      });
      const { context } = contextAt(doc.slice(0, cursor));
      const option = linkCompletions(context)!.options[0];
      (option.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(
        view,
        option,
        6,
        cursor,
      );
      expect(view.state.doc.toString()).toBe(expected);
      expect(view.state.selection.main.head).toBe('ask [[Pottery]]'.length);
      view.destroy();
      view = undefined;
    }
  });
});
