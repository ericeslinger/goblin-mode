// The note editor: CodeMirror 6 with live preview and source modes over
// one markdown string. Framework-free; the host app wraps it.
import { startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import type { Mode } from './live/decorations';
import { livePreview, modeField, setMode } from './live/extension';
import { hooksFacet, type NoteEditorHooks } from './live/hooks';
import {
  continueList,
  insertWikiLink,
  setList,
  shiftLines,
  toggleMark,
  toggleTaskLine,
} from './live/commands';
import { linkAutocomplete } from './live/link-complete';
import { noteTheme } from './live/theme';

export interface NoteEditorOptions extends NoteEditorHooks {
  parent: HTMLElement;
  text?: string;
  mode?: Mode;
  /** Accessible name for the editing area, e.g. "New note". */
  label?: string;
  placeholder?: string;
  /** Shown but not editable, e.g. while the note has not arrived. */
  readOnly?: boolean;
  /** Called with the full text after every change. */
  onChange?: (text: string) => void;
}

export interface NoteEditor {
  readonly view: EditorView;
  getText(): string;
  /** Replaces the whole text (e.g. a different note was opened). */
  setText(text: string): void;
  /**
   * Changes the text to `text` in place, touching only the span that
   * differs, so the cursor and selection stay where they were (a change
   * merged in from elsewhere, #37). Not reported as typing, not undoable.
   */
  updateText(text: string): void;
  getMode(): Mode;
  setMode(mode: Mode): void;
  setReadOnly(readOnly: boolean): void;
  /** Toolbar actions. */
  toggleTask(): void;
  insertWikiLink(): void;
  /** `*bold*` and `_italic_`, the house convention. */
  toggleBold(): void;
  toggleItalic(): void;
  bulletList(): void;
  numberedList(): void;
  indent(): void;
  outdent(): void;
  focus(): void;
  destroy(): void;
}

/** Marks text the host loaded (setText), which is not the user typing. */
const loaded = Annotation.define<boolean>();

/** Both halves of read-only: no edits, and no caret or keyboard input. */
function readOnlyExtension(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

export function createNoteEditor(options: NoteEditorOptions): NoteEditor {
  const { openLink, resolveAttachment, suggestLinks } = options;
  const editing = new Compartment();
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
        { key: 'Enter', run: continueList },
        { key: 'Mod-Enter', run: toggleTaskLine },
        { key: 'Mod-k', run: insertWikiLink },
        { key: 'Mod-b', run: toggleMark('*') },
        { key: 'Mod-i', run: toggleMark('_') },
        { key: 'Mod-]', run: shiftLines(1) },
        { key: 'Mod-[', run: shiftLines(-1) },
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
      hooksFacet.of({ openLink, resolveAttachment, suggestLinks }),
      linkAutocomplete,
      livePreview(options.mode ?? 'live'),
      noteTheme,
      editing.of(readOnlyExtension(options.readOnly ?? false)),
      EditorView.updateListener.of((update) => {
        // Only the user's edits: text the host loads is not reported back,
        // or opening a note would read as typing in it.
        const typed = update.transactions.some((tr) => tr.docChanged && !tr.annotation(loaded));
        if (typed) options.onChange?.(update.state.doc.toString());
      }),
    ],
  });
  const view = new EditorView({ state, parent: options.parent });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      const changes = view.state.changes({ from: 0, to: view.state.doc.length, insert: text });
      view.dispatch({
        changes,
        selection: EditorSelection.cursor(changes.newLength),
        // Not undoable either: undo must never bring back another note.
        annotations: [loaded.of(true), Transaction.addToHistory.of(false)],
      });
    },
    updateText(text) {
      const doc = view.state.doc.toString();
      if (doc === text) return;
      let from = 0;
      while (from < doc.length && from < text.length && doc[from] === text[from]) from++;
      let end = 0;
      while (
        end < doc.length - from &&
        end < text.length - from &&
        doc[doc.length - 1 - end] === text[text.length - 1 - end]
      )
        end++;
      view.dispatch({
        changes: { from, to: doc.length - end, insert: text.slice(from, text.length - end) },
        annotations: [loaded.of(true), Transaction.addToHistory.of(false)],
      });
    },
    getMode: () => view.state.field(modeField),
    setMode(mode) {
      view.dispatch({ effects: setMode.of(mode) });
    },
    setReadOnly(readOnly) {
      view.dispatch({ effects: editing.reconfigure(readOnlyExtension(readOnly)) });
    },
    toggleTask: () => void toggleTaskLine(view),
    toggleBold: () => void toggleMark('*')(view),
    toggleItalic: () => void toggleMark('_')(view),
    bulletList: () => void setList('bullet')(view),
    numberedList: () => void setList('number')(view),
    indent: () => void shiftLines(1)(view),
    outdent: () => void shiftLines(-1)(view),
    insertWikiLink: () => {
      insertWikiLink(view);
      // Offer names at once, as typing `[[` would.
      startCompletion(view);
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
