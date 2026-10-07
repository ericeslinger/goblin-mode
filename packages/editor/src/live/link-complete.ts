// Autocomplete for `[[`: as soon as a wiki link is opened, the host's
// suggestions (concepts, synonyms, note titles) are offered; picking one
// writes the name and closes the link.
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  autocompletion,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { hooksFacet } from './hooks';

/** An open wiki link before the cursor: `[[` and the name so far. */
const OPEN_LINK = /\[\[[^[\]\n|]*$/;

const LABELS: Record<string, string> = { new: 'new concept' };

/** Writes `name]]`, reusing a `]]` already after the cursor. */
function apply(name: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const closed = view.state.sliceDoc(to, to + 2) === ']]';
    const insert = closed ? name : `${name}]]`;
    const end = from + name.length + 2;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: end } });
  };
}

export function linkCompletions(context: CompletionContext): CompletionResult | null {
  const { suggestLinks } = context.state.facet(hooksFacet);
  if (!suggestLinks) return null;
  const open = context.matchBefore(OPEN_LINK);
  if (!open) return null;
  const from = open.from + 2;
  const options = suggestLinks(open.text.slice(2)).map((s) => ({
    label: s.name,
    detail: LABELS[s.kind] ?? s.kind,
    apply: apply(s.name),
  }));
  return { from, options, filter: false };
}

export const linkAutocomplete = autocompletion({
  override: [linkCompletions],
  activateOnTyping: true,
  // Nothing is picked until chosen (arrow keys or a tap), so Enter
  // still starts a new line (review on #65).
  selectOnOpen: false,
  icons: false,
});
