import { merge3 } from '@mossgoblin/schema';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  booleanAttribute,
  effect,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import {
  type AccessoryBar,
  createAccessoryBar,
  createNoteEditor,
  type NoteEditor,
} from '@mossgoblin/editor';
import { EditorModeService } from './editor-mode.service';

/** Touch screens get the keyboard accessory bar instead of shortcuts. */
function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

interface FormatAction {
  label: string;
  name: string;
  /** The desktop key, shown in the toolbar's tooltip. */
  keys?: string;
  style?: { fontWeight?: string; fontStyle?: string };
  run: (editor: NoteEditor) => void;
}

/**
 * The formatting actions, shared by the touch ribbon (#77) and the
 * desktop toolbar (2026-10-07, Eric: lists and the rest by mouse).
 * Image insert joins them with attachments (M4).
 */
const FORMAT_ACTIONS: FormatAction[] = [
  { label: '☐', name: 'Checklist item', keys: 'Ctrl+Enter', run: (e) => e.toggleTask() },
  {
    label: 'B',
    name: 'Bold',
    keys: 'Ctrl+B',
    style: { fontWeight: '700' },
    run: (e) => e.toggleBold(),
  },
  {
    label: 'I',
    name: 'Italic',
    keys: 'Ctrl+I',
    style: { fontStyle: 'italic' },
    run: (e) => e.toggleItalic(),
  },
  { label: '[[', name: 'Insert link', keys: 'Ctrl+K', run: (e) => e.insertWikiLink() },
  { label: '•', name: 'Bulleted list', run: (e) => e.bulletList() },
  { label: '1.', name: 'Numbered list', run: (e) => e.numberedList() },
  { label: '⇤', name: 'Outdent', keys: 'Ctrl+[', run: (e) => e.outdent() },
  { label: '⇥', name: 'Indent', keys: 'Ctrl+]', run: (e) => e.indent() },
];

/**
 * The Angular face of @mossgoblin/editor: text in, changes out, mode from
 * EditorModeService. All editing behaviour lives in the package.
 */
@Component({
  selector: 'app-note-editor',
  template: `
    @if (!touch && !readOnly()) {
      <div class="tools" role="toolbar" aria-label="Formatting">
        @for (action of actions; track action.name) {
          <button
            type="button"
            [attr.aria-label]="action.name"
            [title]="action.keys ? action.name + ' (' + action.keys + ')' : action.name"
            [style.font-weight]="action.style?.fontWeight"
            [style.font-style]="action.style?.fontStyle"
            (mousedown)="$event.preventDefault()"
            (click)="format(action)"
          >
            {{ action.label }}
          </button>
        }
      </div>
    }
    <div #host class="host"></div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .host {
      flex: 1;
      min-height: 0;
    }
    .tools {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      padding-bottom: var(--space-1);
    }
    .tools button {
      min-width: 32px;
      min-height: 32px;
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      cursor: pointer;
    }
    .tools button:hover {
      border-color: var(--accent);
    }
  `,
})
export class NoteEditorComponent {
  readonly text = input('');
  /**
   * Which note `text` belongs to. Opening another note reloads the editor
   * even when the text is unchanged (two empty notes in a row).
   */
  readonly noteId = input<string | undefined>(undefined);
  /**
   * Set when `text` is a change merged in from elsewhere: the text it was
   * merged into. Anything typed since is kept, merged again here (#37).
   */
  readonly base = input<string | undefined>(undefined);
  readonly label = input('Note');
  readonly placeholder = input('');
  readonly autofocus = input(false, { transform: booleanAttribute });
  /** Shown but not editable (a linked note that has not arrived yet). */
  readonly readOnly = input(false);
  /** Names a `[[` can complete to (the host ranks them). */
  readonly suggestLinks = input<(query: string) => { name: string; kind: string }[]>();
  readonly textChange = output<string>();
  /** A wiki link was tapped; carries its target name. */
  readonly linkOpen = output<string>();

  /** On a touch screen the actions ride on the keyboard instead. */
  protected readonly touch = isTouch();
  protected readonly actions = FORMAT_ACTIONS;
  private readonly modes = inject(EditorModeService);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private editor?: NoteEditor;
  private bar?: AccessoryBar;
  /** What `load` showed ahead of the inputs, so they do not show it again. */
  private loaded?: { id: string; text: string };
  /** The note the editor holds. */
  private shownId?: string;

  constructor() {
    afterNextRender(() => {
      this.shownId = untracked(this.noteId);
      this.editor = createNoteEditor({
        parent: this.host().nativeElement,
        text: untracked(this.text),
        label: untracked(this.label),
        placeholder: untracked(this.placeholder),
        readOnly: untracked(this.readOnly),
        openLink: (target) => this.linkOpen.emit(target),
        suggestLinks: (query) => untracked(this.suggestLinks)?.(query) ?? [],
        mode: untracked(this.modes.mode),
        onChange: (text) => this.textChange.emit(text),
      });
      if (this.touch) {
        const editor = this.editor;
        // The ribbon over the keyboard (#77). Image insert joins it with
        // attachments (M4).
        this.bar = createAccessoryBar(editor, [
          ...FORMAT_ACTIONS.map((action) => ({ ...action, run: () => action.run(editor) })),
          // Hides the keyboard; pinned so a narrow phone always shows it.
          { label: 'Done', pinned: true, run: () => editor.view.contentDOM.blur() },
        ]);
      }
      if (untracked(this.autofocus)) this.editor.focus();
    });

    effect(() => {
      const mode = this.modes.mode();
      if (this.editor && this.editor.getMode() !== mode) this.editor.setMode(mode);
    });

    let wasReadOnly = untracked(this.readOnly);
    effect(() => {
      const readOnly = this.readOnly();
      this.editor?.setReadOnly(readOnly);
      // A note that was waiting and arrived is ready to type in.
      if (wasReadOnly && !readOnly && untracked(this.autofocus)) this.editor?.focus();
      wasReadOnly = readOnly;
    });

    effect(() => {
      const id = this.noteId();
      const text = this.text();
      const base = this.base();
      // Already shown by `load`; typing since then must not be undone.
      const loaded = this.loaded;
      this.loaded = undefined;
      if (loaded && loaded.id === id && loaded.text === text) return;
      if (!this.editor) return;
      const shown = this.shownId;
      this.shownId = id;
      if (base === undefined || id !== shown) {
        if (this.editor.getText() !== text) this.editor.setText(text);
        return;
      }
      // The same note, changed elsewhere: keep keys typed since `base`,
      // in place, the cursor where it was.
      const merged = merge3(base, this.editor.getText(), text);
      this.editor.updateText(merged);
      if (merged !== text) this.textChange.emit(merged);
    });

    inject(DestroyRef).onDestroy(() => {
      this.bar?.destroy();
      this.editor?.destroy();
    });
  }

  focus(): void {
    this.editor?.focus();
  }

  /** A toolbar click: the action, then back to typing. */
  protected format(action: FormatAction): void {
    if (!this.editor) return;
    action.run(this.editor);
    this.editor.focus();
  }

  /**
   * Shows a note's text now, ahead of the `noteId` and `text` inputs,
   * so keys typed before the next render land in it (New, a template).
   */
  load(noteId: string, text: string): void {
    if (!this.editor) return;
    this.loaded = { id: noteId, text };
    this.shownId = noteId;
    if (this.editor.getText() !== text) this.editor.setText(text);
  }
}
