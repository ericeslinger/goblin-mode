import { EditorSelection } from '@codemirror/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNoteEditor, type NoteEditor } from './editor';

let editor: NoteEditor | undefined;
afterEach(() => {
  editor?.destroy();
  document.body.innerHTML = '';
});

function make(text: string, extra: Partial<Parameters<typeof createNoteEditor>[0]> = {}) {
  const parent = document.createElement('div');
  document.body.append(parent);
  editor = createNoteEditor({ parent, text, label: 'New note', ...extra });
  return editor;
}

describe('createNoteEditor', () => {
  it('opens with the caret at the end of the note', () => {
    const e = make('one\ntwo');
    expect(e.view.state.selection.main.head).toBe(7);
    e.setText('three');
    expect(e.view.state.selection.main.head).toBe(5);
  });

  it('opens and replaces notes with Windows line endings', () => {
    const e = make('one\r\ntwo\r\n');
    expect(e.getText()).toBe('one\ntwo\n');
    expect(e.view.state.selection.main.head).toBe(8);
    e.setText('a\r\nb');
    expect(e.view.state.selection.main.head).toBe(3);
  });

  it('labels the editing area for assistive tech', () => {
    const e = make('');
    expect(e.view.contentDOM.getAttribute('aria-label')).toBe('New note');
  });

  it('reports every change with the full text', () => {
    const onChange = vi.fn();
    const e = make('a', { onChange });
    e.view.dispatch({ changes: { from: 1, insert: 'b' } });
    expect(onChange).toHaveBeenLastCalledWith('ab');
  });

  it('never changes the text when switching modes', () => {
    const text = '## Plan\n\n- [ ] call [[Vikas|vik]] *soon*\n\n![p](attachment:x)';
    const e = make(text);
    e.setMode('source');
    expect(e.getMode()).toBe('source');
    e.setMode('live');
    expect(e.getText()).toBe(text);
  });

  it('draws a checkbox in live mode that ticks the task in the text', () => {
    const e = make('- [ ] eggs\nmore');
    e.view.dispatch({ selection: EditorSelection.cursor(e.getText().length) });
    const box = e.view.dom.querySelector<HTMLInputElement>('input.mg-checkbox');
    expect(box?.getAttribute('aria-label')).toBe('Mark done');
    box!.click();
    expect(e.getText()).toBe('- [x] eggs\nmore');
  });

  it('draws wiki links as chips that call openLink', () => {
    const openLink = vi.fn();
    const e = make('see [[Vikas]]\n', { openLink });
    e.view.dispatch({ selection: EditorSelection.cursor(e.getText().length) });
    const chip = e.view.dom.querySelector<HTMLElement>('.mg-wikilink');
    expect(chip?.textContent).toBe('Vikas');
    chip!.click();
    expect(openLink).toHaveBeenCalledWith('Vikas');
  });

  it('shows no widgets in source mode', () => {
    const e = make('- [ ] eggs [[Vikas]]\n', { mode: 'source' });
    e.view.dispatch({ selection: EditorSelection.cursor(e.getText().length) });
    expect(e.view.dom.querySelector('.mg-checkbox, .mg-wikilink')).toBeNull();
  });

  it('runs the toolbar commands on the cursor line', () => {
    const e = make('eggs');
    e.toggleTask();
    expect(e.getText()).toBe('- [ ] eggs');
  });
});
