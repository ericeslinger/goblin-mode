import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hooksFacet } from './hooks';
import { moodCompletions } from './mood-complete';

function contextAt(doc: string, suggest = vi.fn((_q: string) => ['calm', 'cheerful'])) {
  const state = EditorState.create({ doc, extensions: [hooksFacet.of({ suggestMoods: suggest })] });
  return { context: new CompletionContext(state, doc.length, false), suggest };
}

let view: EditorView | undefined;
afterEach(() => view?.destroy());

describe('moodCompletions', () => {
  it('offers moods used before, and a new one, for the mood being typed', () => {
    const { context, suggest } = contextAt('Feelings\nMoods: [[sad]], c');
    const result = moodCompletions(context)!;
    expect(suggest).toHaveBeenCalledWith('c');
    expect(result.from).toBe('Feelings\nMoods: [[sad]], '.length);
    expect(result.options.map((o) => [o.label, o.detail])).toEqual([
      ['calm', undefined],
      ['cheerful', undefined],
      ['c', 'new mood'],
    ]);
    // A mood already known is not offered again as new.
    const known = moodCompletions(contextAt('- *Moods:* Calm').context)!;
    expect(known.options.map((o) => o.label)).toEqual(['calm', 'cheerful']);
  });

  it('stays quiet off a Moods line, inside a link, or on an empty one', () => {
    expect(moodCompletions(contextAt('My moods: c').context)).toBeNull();
    expect(moodCompletions(contextAt('Moods: [[ca').context)).toBeNull();
    expect(moodCompletions(contextAt('Moods: ').context)).toBeNull();
    expect(moodCompletions(contextAt('calm').context)).toBeNull();
  });

  it('writes the mood as a link and starts the next', () => {
    const doc = 'Moods: [[sad]], ca';
    view = new EditorView({
      state: EditorState.create({ doc, extensions: [hooksFacet.of({ suggestMoods: () => [] })] }),
    });
    const result = moodCompletions(new CompletionContext(view.state, doc.length, false))!;
    const pick = result.options[0];
    (pick.apply as (v: EditorView, c: typeof pick, f: number, t: number) => void)(
      view,
      pick,
      result.from,
      doc.length,
    );
    expect(view.state.doc.toString()).toBe('Moods: [[sad]], [[ca]], ');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });
});
