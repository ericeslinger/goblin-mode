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

const TASK_LINE = /^(\s*)([-*+]|\d+[.)])([ \t]+)\[[ xX]\][ \t]?/;
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])([ \t]+)/;

/**
 * Makes the cursor's line a task, or a task back into a plain list item:
 * `text` becomes `- [ ] text`, `- text` becomes `- [ ] text`, and
 * `- [ ] text` becomes `- text`.
 */
export const toggleTaskLine: Command = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const task = TASK_LINE.exec(line.text);
  if (task) {
    const keep = task[1].length + task[2].length + task[3].length;
    dispatch({
      changes: { from: line.from + keep, to: line.from + task[0].length, insert: '' },
      userEvent: 'input.toggle-task',
    });
    return true;
  }
  const list = LIST_LINE.exec(line.text);
  if (list) {
    dispatch({
      changes: { from: line.from + list[0].length, insert: '[ ] ' },
      userEvent: 'input.toggle-task',
    });
    return true;
  }
  const indent = /^\s*/.exec(line.text)![0].length;
  dispatch({
    changes: { from: line.from + indent, insert: '- [ ] ' },
    userEvent: 'input.toggle-task',
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
