import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { activeLines, livePreview, modeField, setMode } from './extension';

describe('activeLines', () => {
  it('collects every line any selection range touches', () => {
    const state = EditorState.create({
      doc: 'a\nb\nc\nd',
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.cursor(7)]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect([...activeLines(state)].sort()).toEqual([1, 2, 4]);
  });
});

describe('modeField', () => {
  it('starts in the given mode and follows setMode', () => {
    let state = EditorState.create({ doc: 'x', extensions: livePreview('source') });
    expect(state.field(modeField)).toBe('source');
    state = state.update({ effects: setMode.of('live') }).state;
    expect(state.field(modeField)).toBe('live');
  });

  it('never touches the document', () => {
    let state = EditorState.create({ doc: '- [ ] a [[B]]', extensions: livePreview() });
    state = state.update({ effects: setMode.of('source') }).state;
    expect(state.doc.toString()).toBe('- [ ] a [[B]]');
  });
});
