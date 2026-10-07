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

/**
 * The Angular face of @mossgoblin/editor: text in, changes out, mode from
 * EditorModeService. All editing behaviour lives in the package.
 */
@Component({
  selector: 'app-note-editor',
  template: '<div #host class="host"></div>',
  styles: ':host { display: block; min-height: 0; } .host { height: 100%; }',
})
export class NoteEditorComponent {
  readonly text = input('');
  /**
   * Which note `text` belongs to. Opening another note reloads the editor
   * even when the text is unchanged (two empty notes in a row).
   */
  readonly noteId = input<string | undefined>(undefined);
  readonly label = input('Note');
  readonly placeholder = input('');
  readonly autofocus = input(false, { transform: booleanAttribute });
  /** Shown but not editable (a linked note that has not arrived yet). */
  readonly readOnly = input(false);
  readonly textChange = output<string>();

  private readonly modes = inject(EditorModeService);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private editor?: NoteEditor;
  private bar?: AccessoryBar;

  constructor() {
    afterNextRender(() => {
      this.editor = createNoteEditor({
        parent: this.host().nativeElement,
        text: untracked(this.text),
        label: untracked(this.label),
        placeholder: untracked(this.placeholder),
        readOnly: untracked(this.readOnly),
        mode: untracked(this.modes.mode),
        onChange: (text) => this.textChange.emit(text),
      });
      if (isTouch()) {
        const editor = this.editor;
        this.bar = createAccessoryBar(editor, [
          { label: '[[', name: 'Insert link', run: () => editor.insertWikiLink() },
          { label: '☐', name: 'Toggle task', run: () => editor.toggleTask() },
          { label: 'Done', run: () => editor.view.contentDOM.blur() },
        ]);
      }
      if (untracked(this.autofocus)) this.editor.focus();
    });

    effect(() => {
      const mode = this.modes.mode();
      if (this.editor && this.editor.getMode() !== mode) this.editor.setMode(mode);
    });

    effect(() => {
      const readOnly = this.readOnly();
      this.editor?.setReadOnly(readOnly);
    });

    effect(() => {
      this.noteId();
      const text = this.text();
      if (this.editor && this.editor.getText() !== text) this.editor.setText(text);
    });

    inject(DestroyRef).onDestroy(() => {
      this.bar?.destroy();
      this.editor?.destroy();
    });
  }

  focus(): void {
    this.editor?.focus();
  }
}
