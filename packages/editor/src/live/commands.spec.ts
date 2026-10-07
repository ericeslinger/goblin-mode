import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  continueList,
  insertWikiLink,
  setList,
  shiftLines,
  toggleMark,
  toggleTaskAt,
  toggleTaskLine,
} from './commands';

function run(
  command: typeof toggleTaskLine,
  doc: string,
  cursor: number,
  anchor = cursor,
): EditorState {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, cursor) });
  command({ state, dispatch: (tr: TransactionSpec) => (state = state.update(tr).state) });
  return state;
}

describe('toggleTaskAt', () => {
  it('ticks and unticks the box', () => {
    const state = EditorState.create({ doc: '- [ ] a\n- [x] b' });
    expect(state.update(toggleTaskAt(state, 3)).state.doc.toString()).toBe('- [x] a\n- [x] b');
    expect(state.update(toggleTaskAt(state, 11)).state.doc.toString()).toBe('- [ ] a\n- [ ] b');
  });
});

describe('toggleTaskLine', () => {
  it('leaves the cursor after a box put in where it was', () => {
    const state = run(toggleTaskLine, 'a\n', 2);
    expect(state.doc.toString()).toBe('a\n- [ ] ');
    expect(state.selection.main.head).toBe(8);
  });

  it('turns plain text into a task', () => {
    expect(run(toggleTaskLine, 'buy a card', 3).doc.toString()).toBe('- [ ] buy a card');
  });

  it('keeps indentation', () => {
    expect(run(toggleTaskLine, '  buy', 3).doc.toString()).toBe('  - [ ] buy');
  });

  it('turns a list item into a task and back, touching nothing else', () => {
    const task = run(toggleTaskLine, '1. buy', 4).doc.toString();
    expect(task).toBe('1. [ ] buy');
    expect(run(toggleTaskLine, '- [x] buy', 7).doc.toString()).toBe('- buy');
  });
});

describe('toggleTaskLine in blockquotes', () => {
  it('keeps quote markers in front', () => {
    expect(run(toggleTaskLine, '> buy', 3).doc.toString()).toBe('> - [ ] buy');
    expect(run(toggleTaskLine, '> - a', 4).doc.toString()).toBe('> - [ ] a');
    expect(run(toggleTaskLine, '> > - [x] a', 9).doc.toString()).toBe('> > - a');
  });
});

describe('insertWikiLink', () => {
  it('inserts empty brackets with the cursor inside', () => {
    const state = run(insertWikiLink, 'see ', 4);
    expect(state.doc.toString()).toBe('see [[]]');
    expect(state.selection.main.head).toBe(6);
  });

  it('wraps a selection', () => {
    const state = run(insertWikiLink, 'see Vikas', 9, 4);
    expect(state.doc.toString()).toBe('see [[Vikas]]');
    expect(state.selection.main.head).toBe(11);
  });
});

describe('continueList', () => {
  /** Runs Enter at the end of `doc`; null when it falls through. */
  function enter(doc: string, at = doc.length): { doc: string; head: number } | null {
    let state = EditorState.create({ doc, selection: EditorSelection.cursor(at) });
    const handled = continueList({
      state,
      dispatch: (tr: TransactionSpec) => (state = state.update(tr).state),
    });
    return handled ? { doc: state.doc.toString(), head: state.selection.main.head } : null;
  }

  it('starts the next bullet with the same marker', () => {
    expect(enter('- one')).toEqual({ doc: '- one\n- ', head: 8 });
    expect(enter('* seven')?.doc).toBe('* seven\n* ');
  });

  it('numbers the next ordered item', () => {
    expect(enter('9. eight')?.doc).toBe('9. eight\n10. ');
    expect(enter('1) a')?.doc).toBe('1) a\n2) ');
  });

  it('starts an unticked task after a task, ticked or not', () => {
    expect(enter('- [x] eggs')?.doc).toBe('- [x] eggs\n- [ ] ');
  });

  it('keeps indentation and quote markers', () => {
    expect(enter('  - nested')?.doc).toBe('  - nested\n  - ');
    expect(enter('> - quoted')?.doc).toBe('> - quoted\n> - ');
  });

  it('ends the list on an empty item', () => {
    expect(enter('- one\n- ')?.doc).toBe('- one\n');
    expect(enter('- one\n- [ ] ')?.doc).toBe('- one\n');
    expect(enter('> - ')?.doc).toBe('> ');
  });

  it('splits an item when the cursor is mid-line', () => {
    expect(enter('- one two', 5)?.doc).toBe('- one\n-  two');
  });

  it('moves an empty nested item out to its parent level', () => {
    expect(enter('- a\n  - b\n  - ')?.doc).toBe('- a\n  - b\n- ');
    expect(enter('1. a\n   - b\n   - ')?.doc).toBe('1. a\n   - b\n- ');
  });

  it('leaves Enter alone inside code and on lines that only look like lists', () => {
    expect(enter('```\n- a')).toBeNull();
    expect(enter('```\n- a\n```', 7)).toBeNull();
    expect(enter('- - -')).toBeNull();
    expect(enter('* * *')).toBeNull();
  });

  it('leaves Enter alone outside lists and inside the marker', () => {
    expect(enter('plain text')).toBeNull();
    expect(enter('- one', 1)).toBeNull();
  });
});

const text = (state: EditorState) => state.doc.toString();
const selected = (state: EditorState) =>
  state.sliceDoc(state.selection.main.from, state.selection.main.to);

describe('toggleMark', () => {
  it('wraps the selection, and unwraps it again', () => {
    const bold = run(toggleMark('*'), 'a word here', 6, 2);
    expect(text(bold)).toBe('a *word* here');
    expect(selected(bold)).toBe('word');
    let again = bold;
    toggleMark('*')({ state: bold, dispatch: (tr) => (again = bold.update(tr).state) });
    expect(text(again)).toBe('a word here');
    expect(text(run(toggleMark('_'), 'a _word_ here', 8, 2))).toBe('a word here');
    // Two emphases selected together are wrapped, not taken apart.
    expect(text(run(toggleMark('*'), '*a* and *b*', 11, 0))).toBe('**a* and *b**');
  });

  it('puts a pair in with the cursor between when nothing is selected', () => {
    const state = run(toggleMark('_'), 'say ', 4);
    expect(text(state)).toBe('say __');
    expect(state.selection.main.head).toBe(5);
  });
});

describe('setList', () => {
  it('makes lines a list, numbered down the selection, keeping indent and tasks', () => {
    const doc = 'eggs\n  milk\n\n- [ ] bread';
    expect(text(run(setList('bullet'), doc, doc.length, 0))).toBe(
      '- eggs\n  - milk\n\n- [ ] bread',
    );
    expect(text(run(setList('number'), doc, doc.length, 0))).toBe(
      '1. eggs\n  2. milk\n\n3. [ ] bread',
    );
  });

  it('turns a list of that kind back into plain lines', () => {
    expect(text(run(setList('bullet'), '- a\n- b', 7, 0))).toBe('a\nb');
    expect(text(run(setList('number'), '- a', 1))).toBe('1. a');
  });

  it('leaves the cursor after a marker put in where it was', () => {
    const state = run(setList('bullet'), 'x\ny', 2);
    expect(state.doc.toString()).toBe('x\n- y');
    expect(state.selection.main.head).toBe(4);
  });

  it('starts a list on an empty line', () => {
    const state = run(setList('number'), '', 0);
    expect(text(state)).toBe('1. ');
    expect(state.selection.main.head).toBe(3);
  });
});

describe('shiftLines', () => {
  it('indents and outdents the selected lines a list level', () => {
    expect(text(run(shiftLines(1), '- a\n- b\n\nc', 9, 0))).toBe('  - a\n  - b\n\nc');
    expect(text(run(shiftLines(-1), '  - a\n\t- b\n- c', 12, 0))).toBe('- a\n- b\n- c');
    expect(run(shiftLines(-1), '- a', 1).doc.toString()).toBe('- a');
    // Plain text is not indented into a code block.
    expect(text(run(shiftLines(1), 'plain', 2))).toBe('plain');
    // Nothing to do still takes the key (Mod-[ is the browser's Back).
    let dispatched = false;
    const state = EditorState.create({ doc: 'a' });
    expect(shiftLines(-1)({ state, dispatch: () => (dispatched = true) })).toBe(true);
    expect(dispatched).toBe(false);
  });
});
