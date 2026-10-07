// Edits the toolbar and widgets make. Each is a plain text change on the
// note, so nothing is ever rewritten beyond the characters touched.
import {
  type ChangeSet,
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state';
import type { Nodes } from 'mdast';
import { parseNote } from '../grammar/parse';

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
  const changes = state.changes(
    list ? { from: at + list[0].length, insert: '[ ] ' } : { from: at, insert: '- [ ] ' },
  );
  dispatch({ changes, selection: after(state, changes), userEvent: 'input.toggle-task' });
  return true;
};

/**
 * The selection after `changes`, kept after text inserted right at the
 * cursor: a marker put in where the cursor is goes before what is typed
 * next, not after it.
 */
function after(state: EditorState, changes: ChangeSet) {
  return state.selection.map(changes, 1);
}

const ITEM = /^([-*+]|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]?)?/;

interface ListContext {
  /** The list item starting on the cursor's line, if any. */
  item?: Nodes;
  /** The item that item is nested in, if any. */
  parent?: Nodes;
  /** Whether the cursor is inside a code block or inline code. */
  inCode: boolean;
}

/** What the one grammar says about the cursor's position and line. */
function listContext(state: EditorState, pos: number, lineNumber: number): ListContext {
  const context: ListContext = { inCode: false };
  const items: Nodes[] = [];
  const walk = (node: Nodes) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || pos < start || pos > end) return;
    if (node.type === 'code' || node.type === 'inlineCode') context.inCode = true;
    if (node.type === 'listItem') items.push(node);
    if ('children' in node) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(parseNote(state.doc.toString()));
  const at = items.findIndex((i) => i.position?.start.line === lineNumber);
  if (at !== -1) {
    context.item = items[at];
    context.parent = items[at - 1];
  }
  return context;
}

/**
 * Enter inside a list item starts the next item: the same bullet, the
 * next number, and an unticked box for tasks, after the same indent and
 * quote markers. Enter on an item with nothing typed after its marker
 * ends the list, or for a nested item moves it out to its parent's
 * level. Inside code, on lines that only look like lists (`- - -`), and
 * anywhere else, falls through to the default Enter. The grammar decides
 * what is a list item, so this agrees with what live preview draws.
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

  const context = listContext(state, sel.head, line.number);
  if (context.inCode || !context.item) return false;

  if (line.text.slice(prefix.length + item[0].length).trim() === '') {
    const parentStart = context.parent?.position?.start.offset;
    if (parentStart !== undefined) {
      // A nested empty item: move it out to its parent's indentation.
      const parentLine = state.doc.lineAt(parentStart);
      const outer = parentLine.text.slice(0, parentStart - parentLine.from);
      dispatch({
        changes: { from: line.from, to: line.from + prefix.length, insert: outer },
        userEvent: 'input.outdent-list',
      });
      return true;
    }
    // A top-level empty item: end the list, keeping any quote markers.
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

/**
 * Wraps the selection in `marker` (`*` bold, `_` italic, the house
 * convention), or unwraps it if it already is; with nothing selected,
 * puts a pair in with the cursor between.
 */
export function toggleMark(marker: '*' | '_'): Command {
  return ({ state, dispatch }) => {
    const n = marker.length;
    dispatch({
      ...state.changeByRange((range) => {
        if (range.empty) {
          return {
            changes: { from: range.from, insert: marker + marker },
            range: EditorSelection.cursor(range.from + n),
          };
        }
        const inner = state.sliceDoc(range.from, range.to);
        // Wrapped as a whole: `*a and b*`, not two emphases `*a* and *b*`.
        const wrapped =
          inner.length >= 2 * n &&
          inner.startsWith(marker) &&
          inner.endsWith(marker) &&
          !inner.slice(n, -n).includes(marker);
        if (wrapped) {
          return {
            changes: { from: range.from, to: range.to, insert: inner.slice(n, -n) },
            range: EditorSelection.range(range.from, range.to - 2 * n),
          };
        }
        const before = state.sliceDoc(range.from - n, range.from);
        const after = state.sliceDoc(range.to, range.to + n);
        if (before === marker && after === marker) {
          return {
            changes: [
              { from: range.from - n, to: range.from },
              { from: range.to, to: range.to + n },
            ],
            range: EditorSelection.range(range.from - n, range.to - n),
          };
        }
        return {
          changes: [
            { from: range.from, insert: marker },
            { from: range.to, insert: marker },
          ],
          range: EditorSelection.range(range.from + n, range.to + n),
        };
      }),
      userEvent: 'input.format',
    });
    return true;
  };
}

/** The lines the selection touches, each once. */
function selectedLines(state: EditorState) {
  const seen = new Set<number>();
  const lines = [];
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  return lines;
}

/**
 * Makes the selected lines a bulleted or numbered list (numbered 1, 2,
 * 3 down the selection), keeping indentation, quote markers and task
 * boxes; if they all already are that kind, makes them plain lines.
 * Blank lines are left alone.
 */
export function setList(kind: 'bullet' | 'number'): Command {
  return ({ state, dispatch }) => {
    const lines = selectedLines(state).filter((l) => l.text.trim());
    if (!lines.length) {
      const at = state.selection.main.head;
      dispatch({
        changes: { from: at, insert: kind === 'bullet' ? '- ' : '1. ' },
        selection: EditorSelection.cursor(at + (kind === 'bullet' ? 2 : 3)),
        userEvent: 'input.format',
      });
      return true;
    }
    const parts = lines.map((line) => {
      const prefix = PREFIX.exec(line.text)![0].length;
      const list = LIST.exec(line.text.slice(prefix));
      const is = list ? (/\d/.test(list[1]) ? 'number' : 'bullet') : undefined;
      return { line, prefix, list, is };
    });
    const off = parts.every((p) => p.is === kind);
    let count = 0;
    const changes = state.changes(
      parts.map(({ line, prefix, list }) => {
        const from = line.from + prefix;
        const to = from + (list ? list[0].length : 0);
        const insert = off ? '' : kind === 'bullet' ? '- ' : `${++count}. `;
        return { from, to, insert };
      }),
    );
    dispatch({ changes, selection: after(state, changes), userEvent: 'input.format' });
    return true;
  };
}

/**
 * Indents the selected list items one level (two spaces), or outdents
 * any selected line. Plain lines are not indented: four spaces would
 * make them a code block. Always takes the key, so Mod-[ on a line with
 * nothing to outdent is not the browser's Back.
 */
export function shiftLines(direction: 1 | -1): Command {
  return ({ state, dispatch }) => {
    const changes = selectedLines(state).flatMap((line): ChangeSpec[] => {
      if (direction === 1) {
        const prefix = PREFIX.exec(line.text)![0].length;
        return LIST.test(line.text.slice(prefix)) ? [{ from: line.from, insert: '  ' }] : [];
      }
      const lead = /^( {1,2}|\t)/.exec(line.text);
      return lead ? [{ from: line.from, to: line.from + lead[0].length }] : [];
    });
    if (!changes.length) return true;
    const set = state.changes(changes);
    dispatch({
      changes: set,
      selection: after(state, set),
      userEvent: direction === 1 ? 'input.indent' : 'input.outdent',
    });
    return true;
  };
}
