// The note editor: CodeMirror 6 with live preview and source modes over
// one markdown string. Framework-free; the host app wraps it.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import type { Mode } from './live/decorations';
import { livePreview, modeField, setMode } from './live/extension';
import { hooksFacet, type NoteEditorHooks } from './live/hooks';
import { insertWikiLink, toggleTaskLine } from './live/commands';
import { noteTheme } from './live/theme';

export interface NoteEditorOptions extends NoteEditorHooks {
  parent: HTMLElement;
  text?: string;
  mode?: Mode;
  /** Accessible name for the editing area, e.g. "New note". */
  label?: string;
  placeholder?: string;
  /** Called with the full text after every change. */
  onChange?: (text: string) => void;
}

export interface NoteEditor {
  readonly view: EditorView;
  getText(): string;
  /** Replaces the whole text (e.g. a different note was opened). */
  setText(text: string): void;
  getMode(): Mode;
  setMode(mode: Mode): void;
  /** Toolbar actions. */
  toggleTask(): void;
  insertWikiLink(): void;
  focus(): void;
  destroy(): void;
}

export function createNoteEditor(options: NoteEditorOptions): NoteEditor {
  const { openLink, resolveAttachment } = options;
  const base = EditorState.create({ doc: options.text ?? '' });
  const state = EditorState.create({
    doc: base.doc,
    // Open with the caret at the end, to carry on where the note left off.
    // The length is CodeMirror's: it normalises \r\n, so the string's own
    // length can point past the end.
    selection: EditorSelection.cursor(base.doc.length),
    extensions: [
      history(),
      keymap.of([
        { key: 'Mod-Enter', run: toggleTaskLine },
        { key: 'Mod-k', run: insertWikiLink },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        'aria-label': options.label ?? 'Note',
        autocapitalize: 'sentences',
        spellcheck: 'true',
      }),
      placeholder(options.placeholder ?? ''),
      hooksFacet.of({ openLink, resolveAttachment }),
      livePreview(options.mode ?? 'live'),
      noteTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onChange?.(update.state.doc.toString());
      }),
    ],
  });
  const view = new EditorView({ state, parent: options.parent });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      const changes = view.state.changes({ from: 0, to: view.state.doc.length, insert: text });
      view.dispatch({ changes, selection: EditorSelection.cursor(changes.newLength) });
    },
    getMode: () => view.state.field(modeField),
    setMode(mode) {
      view.dispatch({ effects: setMode.of(mode) });
    },
    toggleTask: () => void toggleTaskLine(view),
    insertWikiLink: () => void insertWikiLink(view),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
