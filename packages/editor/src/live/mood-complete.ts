// Autocomplete on a Moods line (#40): a feelings entry names its moods
// after `Moods:`, separated by commas. Typing a mood offers the moods
// used before; picking one, or a new one, writes it as a `[[link]]`,
// so the mood's page lists the entry.
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { hooksFacet } from './hooks';

/**
 * The line so far, ending in a mood being typed: after `Moods:` (bold,
 * listed or not) and any earlier moods, outside a link. Matches the
 * schema's moodLine (packages/schema/src/journal.ts).
 */
const TYPING_MOOD = /^[ \t]*(?:[-*+][ \t]+)?\*?moods\*?[ \t]*:\*?(?:[^\n]*,)?[ \t]*([^,[\]\n]*)$/i;

/** Writes `[[name]]` over what was typed, then `, ` to start the next. */
function apply(name: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const insert = `[[${name}]], `;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
  };
}

export function moodCompletions(context: CompletionContext): CompletionResult | null {
  const { suggestMoods } = context.state.facet(hooksFacet);
  if (!suggestMoods) return null;
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = TYPING_MOOD.exec(before);
  if (!m) return null;
  const typed = m[1].trim();
  // Something typed, or asked for: an empty Moods line stays quiet.
  if (!typed && !context.explicit) return null;
  const from = context.pos - m[1].trimStart().length;
  const known = suggestMoods(typed);
  const options: Completion[] = known.map((name) => ({ label: name, apply: apply(name) }));
  if (typed && !known.some((k) => k.toLowerCase() === typed.toLowerCase())) {
    options.push({ label: typed, detail: 'new mood', apply: apply(typed) });
  }
  return { from, options, filter: false };
}
