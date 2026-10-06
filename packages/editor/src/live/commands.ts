// Edits the toolbar and widgets make. Each is a plain text change on the
// note, so nothing is ever rewritten beyond the characters touched.
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';

type Command = (target: { state: EditorState; dispatch: (tr: TransactionSpec) => void }) => boolean;

/** Flips the `[ ]` / `[x]` whose inner character sits at `pos`. */
export function toggleTaskAt(state: EditorState, pos: number): TransactionSpec {
  const current = state.sliceDoc(pos, pos + 1);
  const insert = current === ' ' ? 'x' : ' ';
  return { changes: { from: pos, to: pos + 1, insert }, userEvent: 'input.toggle-task' };
}

/** Leading indentation and blockquote markers, kept as they are. */
const PREFIX = /^(?:[ \t]*>[ \t]?)*[ \t]*/;
const TASK = /^([-*+]|\d+[.)])([ \t]+)\[[ xX]\][ \t]?/;
const LIST = /^([-*+]|\d+[.)])([ \t]+)/;

/**
 * Makes the cursor's line a task, or a task back into a plain list item:
 * `text` becomes `- [ ] text`, `- text` becomes `- [ ] text`, and
 * `- [ ] text` becomes `- text`. Indentation and `>` quote markers stay
 * in front, so `> text` becomes `> - [ ] text`.
 */
export const toggleTaskLine: Command = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const prefix = PREFIX.exec(line.text)![0].length;
  const at = line.from + prefix;
  const rest = line.text.slice(prefix);
  const task = TASK.exec(rest);
  if (task) {
    const keep = task[1].length + task[2].length;
    dispatch({
      changes: { from: at + keep, to: at + task[0].length, insert: '' },
      userEvent: 'input.toggle-task',
    });
    return true;
  }
  const list = LIST.exec(rest);
  dispatch({
    changes: list ? { from: at + list[0].length, insert: '[ ] ' } : { from: at, insert: '- [ ] ' },
    userEvent: 'input.toggle-task',
  });
  return true;
};

const ITEM = /^([-*+]|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]?)?/;

/**
 * Enter inside a list item starts the next item: the same bullet, the
 * next number, and an unticked box for tasks, after the same indent and
 * quote markers. Enter on an item with nothing typed after its marker
 * ends the list by removing that marker. Elsewhere, falls through to the
 * default Enter.
 */
export const continueList: Command = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  const prefix = PREFIX.exec(line.text)![0];
  const item = ITEM.exec(line.text.slice(prefix.length));
  if (!item) return false;
  const markerEnd = line.from + prefix.length + item[0].length;
  if (sel.head < markerEnd) return false;

  if (line.text.slice(prefix.length + item[0].length).trim() === '') {
    // An empty item: end the list, keeping any quote markers.
    dispatch({
      changes: { from: line.from + prefix.length, to: line.to, insert: '' },
      userEvent: 'input.end-list',
    });
    return true;
  }

  const bullet = item[2] ? `${Number(item[2]) + 1}${item[3]}` : item[1];
  const next = `\n${prefix}${bullet}${item[4]}${item[5] ? '[ ] ' : ''}`;
  dispatch({
    changes: { from: sel.head, insert: next },
    selection: EditorSelection.cursor(sel.head + next.length),
    scrollIntoView: true,
    userEvent: 'input.continue-list',
  });
  return true;
};

/** Wraps the selection in `[[…]]`, leaving the cursor before `]]`. */
export const insertWikiLink: Command = ({ state, dispatch }) => {
  dispatch(
    state.changeByRange((range) => {
      const inner = state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: `[[${inner}]]` },
        range: EditorSelection.cursor(range.from + 2 + inner.length),
      };
    }),
  );
  return true;
};
