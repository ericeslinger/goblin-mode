import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { insertWikiLink, toggleTaskAt, toggleTaskLine } from './commands';

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
