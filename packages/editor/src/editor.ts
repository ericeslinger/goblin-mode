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
import { livePreview, modeField, refreshImages, setMode } from './live/extension';
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
  /**
   * Where the window starts being covered (y, px from the top): an
   * on-screen keyboard and the ribbon over it overlay the page. The
   * editor gets room below its last line and keeps the cursor above
   * that point, bringing it there when the cover grows; undefined when
   * nothing covers it.
   */
  setCoveredFrom(y: number | undefined): void;
  /** Draws images again: an attachment's file became available. */
  refreshImages(): void;
  /**
   * Puts `![caption](attachment:<id>)` on a line of its own at the
   * cursor, and the cursor on the line after it, so the image shows and
   * typing carries on below; undoable like typing.
   */
  insertImage(id: string, caption: string): void;
  /** Puts `[name](attachment:<id>)` on a line of its own, as insertImage (#45). */
  insertFile(id: string, name: string): void;
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
  const { openLink, resolveAttachment, suggestLinks, suggestMoods, openImage, openFile } = options;
  const editing = new Compartment();
  let inset = 0;
  /** How much of the editor's visible box lies at or below `y`. */
  const overlap = (y: number | undefined) => {
    if (y === undefined) return 0;
    const bottom = Math.min(view.scrollDOM.getBoundingClientRect().bottom, window.innerHeight);
    return Math.max(0, Math.ceil(bottom - y));
  };
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
      EditorView.scrollMargins.of(() => ({ bottom: inset })),
      EditorView.contentAttributes.of({
        'aria-label': options.label ?? 'Note',
        autocapitalize: 'sentences',
        spellcheck: 'true',
        // Said outright, so a note long enough to scroll has keyboard
        // access by axe's reckoning, which does not count contenteditable
        // (scrollable-region-focusable, #41). Read only, it still scrolls.
        tabindex: '0',
      }),
      placeholder(options.placeholder ?? ''),
      hooksFacet.of({
        openLink,
        resolveAttachment,
        suggestLinks,
        suggestMoods,
        openImage,
        openFile,
      }),
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

  /** Markdown-safe text for a caption or name. */
  const clean = (text: string) => text.replace(/[[\]\n]/g, ' ').trim();
  /** `line` on a line of its own at the cursor, the cursor on the line after. */
  const insertLine = (markdown: string) => {
    const { state } = view;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    // Its own line: after this one's text, before the rest of it.
    const before = head > line.from ? '\n' : '';
    const insert = `${before}${markdown}\n`;
    view.dispatch({
      changes: { from: head, insert },
      selection: { anchor: head + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    });
  };

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
    setCoveredFrom(y) {
      const px = overlap(y);
      const grew = px > inset;
      inset = px;
      // Room for the last line to scroll above the cover.
      view.scrollDOM.style.paddingBottom = px ? `${px}px` : '';
      if (grew && view.hasFocus) {
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
      }
    },
    refreshImages: () => view.dispatch({ effects: refreshImages.of(null) }),
    insertImage: (id, caption) => insertLine(`![${clean(caption)}](attachment:${id})`),
    insertFile: (id, name) => insertLine(`[${clean(name)}](attachment:${id})`),
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
