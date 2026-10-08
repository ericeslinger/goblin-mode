import { undo } from '@codemirror/commands';
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

describe('images (#44)', () => {
  it('inserts an attachment on a line of its own, and undoes it in one step', () => {
    const e = make('Dinner');
    e.view.dispatch({ selection: { anchor: 3 } });
    e.insertImage('a1', 'menu [draft]');
    expect(e.getText()).toBe('Din\n![menu  draft](attachment:a1)\nner');
    undo(e.view);
    expect(e.getText()).toBe('Dinner');
    e.view.dispatch({ selection: { anchor: 6 } });
    e.insertImage('a2', 'photo');
    expect(e.getText()).toBe('Dinner\n![photo](attachment:a2)\n');
    // The cursor is below the image, so it shows.
    expect(e.view.state.selection.main.head).toBe(e.getText().length);
  });

  it('draws an attachment once its file arrives, and opens it on a tap', () => {
    let url: string | undefined;
    const openImage = vi.fn();
    const e = make('note\n![menu](attachment:a1)\n', {
      resolveAttachment: () => url,
      openImage,
    });
    e.view.dispatch({ selection: { anchor: 0 } });
    expect(e.view.dom.querySelector('img.mg-image')).toBeNull();
    expect(e.view.dom.querySelector('.mg-attachment-placeholder')?.textContent).toBe('menu');
    url = 'blob:http://localhost/x';
    e.refreshImages();
    const img = e.view.dom.querySelector('img.mg-image') as HTMLImageElement;
    expect(img.src).toBe(url);
    img.click();
    expect(openImage).toHaveBeenCalledWith(url, 'menu', 'attachment:a1');
  });
});

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

  it('can be read-only, and still takes text loaded into it', () => {
    const e = make('', { readOnly: true });
    expect(e.view.state.readOnly).toBe(true);
    expect(e.view.contentDOM.getAttribute('contenteditable')).toBe('false');
    e.setText('arrived');
    expect(e.getText()).toBe('arrived');
    e.setReadOnly(false);
    expect(e.view.state.readOnly).toBe(false);
    expect(e.view.contentDOM.getAttribute('contenteditable')).toBe('true');
  });

  it('reports every change with the full text', () => {
    const onChange = vi.fn();
    const e = make('a', { onChange });
    e.view.dispatch({ changes: { from: 1, insert: 'b' } });
    expect(onChange).toHaveBeenLastCalledWith('ab');
  });

  it('does not report text the host loads as a change', () => {
    const onChange = vi.fn();
    const e = make('a', { onChange });
    e.setText('another note');
    e.setText('');
    expect(onChange).not.toHaveBeenCalled();
    expect(undo(e.view)).toBe(false);
    expect(e.getText()).toBe('');
  });

  it('updates text in place, keeping the cursor where it was', () => {
    const onChange = vi.fn();
    const e = make('- [ ] apples\n- [ ] kale\nbre', { onChange });
    // Typing at the end; a tick lands earlier in the note.
    expect(e.view.state.selection.main.head).toBe(27);
    e.updateText('- [x] apples\n- [ ] kale\nbre');
    expect(e.getText()).toBe('- [x] apples\n- [ ] kale\nbre');
    expect(e.view.state.selection.main.head).toBe(27);
    // A line added before the cursor moves it along with its text.
    e.updateText('- [ ] leeks\n- [x] apples\n- [ ] kale\nbre');
    expect(e.view.state.selection.main.head).toBe(39);
    expect(onChange).not.toHaveBeenCalled();
    expect(undo(e.view)).toBe(false);
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
