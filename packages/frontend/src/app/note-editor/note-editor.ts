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
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import {
  type AccessoryBar,
  createAccessoryBar,
  createNoteEditor,
  type NoteEditor,
} from '@mossgoblin/editor';
import { AttachmentsService, captionFor } from '../attachments/attachments.service';
import { EditorModeService } from './editor-mode.service';

/** Touch screens get the keyboard accessory bar instead of shortcuts. */
function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** A key as this platform's keyboard shows it: `Mod` is ⌘ on a Mac. */
export function keyLabel(keys: string, mac: boolean): string {
  return keys.replace('Mod+', mac ? '⌘' : 'Ctrl+');
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

interface FormatAction {
  label: string;
  name: string;
  /** The desktop key as the editor binds it (`Mod` is Ctrl, or ⌘ on a Mac). */
  keys?: string;
  style?: { fontWeight?: string; fontStyle?: string };
  /** Runs on the tap itself: it opens a file picker. */
  immediate?: boolean;
  /** `pickImage` opens the file picker (Insert image). */
  run: (editor: NoteEditor, pickImage: () => void) => void;
}

/**
 * The formatting actions, shared by the touch ribbon (#77) and the
 * desktop toolbar (2026-10-07, Eric: lists and the rest by mouse).
 * Image insert joins them with attachments (M4).
 */
const FORMAT_ACTIONS: FormatAction[] = [
  { label: '☐', name: 'Checklist item', keys: 'Mod+Enter', run: (e) => e.toggleTask() },
  {
    label: 'B',
    name: 'Bold',
    keys: 'Mod+B',
    style: { fontWeight: '700' },
    run: (e) => e.toggleBold(),
  },
  {
    label: 'I',
    name: 'Italic',
    keys: 'Mod+I',
    style: { fontStyle: 'italic' },
    run: (e) => e.toggleItalic(),
  },
  { label: '[[', name: 'Insert link', keys: 'Mod+K', run: (e) => e.insertWikiLink() },
  { label: '•', name: 'Bulleted list', run: (e) => e.bulletList() },
  { label: '1.', name: 'Numbered list', run: (e) => e.numberedList() },
  { label: '⇤', name: 'Outdent', keys: 'Mod+[', run: (e) => e.outdent() },
  { label: '⇥', name: 'Indent', keys: 'Mod+]', run: (e) => e.indent() },
  // A camera or a photo (#44); the picker offers both on a phone.
  { label: '🖼', name: 'Insert image', immediate: true, run: (_e, pick) => pick() },
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
        @for (action of actions; track action.name; let i = $index) {
          <button
            #tool
            type="button"
            [attr.aria-label]="action.name"
            [title]="tooltip(action)"
            [tabindex]="i === active() ? 0 : -1"
            (keydown)="move($event, i)"
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
    <input #picker type="file" accept="image/*" hidden (change)="picked(picker)" />
    @if (problem(); as message) {
      <p class="note-status" role="alert">{{ message }}</p>
    } @else if (attachments.waiting().size; as count) {
      <p class="note-status" role="status">
        {{ count === 1 ? '1 photo' : count + ' photos' }} waiting to upload{{
          attachments.struggling() ? '; uploads are failing, still trying' : ''
        }}{{ attachments.inMemory() ? ' (kept only until this page closes)' : '' }}
      </p>
    }
    <dialog
      #viewer
      class="viewer"
      aria-label="Image"
      (close)="viewing.set(undefined)"
      (click)="closeViewer($event)"
    >
      @if (viewing(); as image) {
        <img [src]="image.src" [alt]="image.alt" />
        <button type="button" class="close" (click)="viewer.close()">Close</button>
      }
    </dialog>
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
    .note-status {
      margin: var(--space-1) 0 0;
      color: var(--quiet);
      font-size: 14px;
    }
    .viewer {
      max-width: 100vw;
      max-height: 100vh;
      width: 100vw;
      height: 100vh;
      margin: 0;
      padding: 0;
      border: 0;
      background: rgb(0 0 0 / 0.9);
    }
    .viewer[open] {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .viewer img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .viewer .close {
      position: absolute;
      top: var(--space-2);
      right: var(--space-2);
      min-height: 44px;
      padding: 0 var(--space-3);
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: 0;
      border-radius: var(--radius-pill);
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
  /** The toolbar's one tab stop; arrow keys move it (ARIA toolbar). */
  protected readonly active = signal(0);
  private readonly tools = viewChildren<ElementRef<HTMLButtonElement>>('tool');
  private readonly modes = inject(EditorModeService);
  protected readonly attachments = inject(AttachmentsService);
  /** The image shown full screen, if any. */
  protected readonly viewing = signal<{ src: string; alt: string } | undefined>(undefined);
  /** Why the last photo could not be attached. */
  protected readonly problem = signal<string | undefined>(undefined);
  private readonly picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');
  private readonly viewer = viewChild.required<ElementRef<HTMLDialogElement>>('viewer');
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
        resolveAttachment: (id) => this.attachments.resolve(id),
        openImage: (src, alt, url) => void this.openViewer(src, alt, url),
        suggestLinks: (query) => untracked(this.suggestLinks)?.(query) ?? [],
        mode: untracked(this.modes.mode),
        onChange: (text) => this.textChange.emit(text),
      });
      if (this.touch) {
        const editor = this.editor;
        // The ribbon over the keyboard (#77). Image insert joins it with
        // attachments (M4).
        this.bar = createAccessoryBar(editor, [
          ...FORMAT_ACTIONS.map((action) => ({
            ...action,
            run: () => action.run(editor, () => this.pickImage()),
          })),
          // Hides the keyboard; pinned so a narrow phone always shows it.
          { label: 'Done', pinned: true, run: () => editor.view.contentDOM.blur() },
        ]);
      }
      if (untracked(this.autofocus)) this.editor.focus();
    });

    // A photo's file arrived (downloaded, or restored from the queue).
    effect(() => {
      this.attachments.arrived();
      this.editor?.refreshImages();
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

  protected tooltip(action: FormatAction): string {
    return action.keys ? `${action.name} (${keyLabel(action.keys, IS_MAC)})` : action.name;
  }

  /** Arrow keys, Home and End move along the toolbar. */
  protected move(event: KeyboardEvent, i: number): void {
    const last = this.actions.length - 1;
    const to =
      event.key === 'ArrowRight'
        ? i === last
          ? 0
          : i + 1
        : event.key === 'ArrowLeft'
          ? i === 0
            ? last
            : i - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : undefined;
    if (to === undefined) return;
    event.preventDefault();
    this.active.set(to);
    this.tools()[to]?.nativeElement.focus();
  }

  /** A toolbar click: the action, then back to typing. */
  protected format(action: FormatAction): void {
    if (!this.editor) return;
    action.run(this.editor, () => this.pickImage());
    if (!action.immediate) this.editor.focus();
  }

  private pickImage(): void {
    this.problem.set(undefined);
    this.picker().nativeElement.click();
  }

  /**
   * Photos chosen: each goes in the note at the cursor at once, before
   * anything is awaited, so it lands in this note even if another opens
   * meanwhile; then the files are kept on the device.
   */
  protected async picked(input: HTMLInputElement): Promise<void> {
    const files = [...(input.files ?? [])];
    input.value = '';
    const noteId = untracked(this.noteId);
    const shown = this.shownId;
    // What each file really is (a moment's read of its first bytes).
    const looked = await Promise.all(
      files.map(async (f) => [f, await this.attachments.inspect(f)] as const),
    );
    if (this.shownId !== shown) {
      this.problem.set('Another note opened before the photo went in. Please add it again.');
      return;
    }
    const kept: Promise<void>[] = [];
    for (const [file, found] of looked) {
      if ('error' in found) {
        this.problem.set(found.error);
        continue;
      }
      const id = this.attachments.newId();
      this.editor?.insertImage(id, captionFor(file.name));
      kept.push(this.attachments.attach(file, id, found.type, noteId));
    }
    this.editor?.focus();
    const results = await Promise.allSettled(kept);
    if (results.some((r) => r.status === 'rejected')) {
      this.problem.set('This device could not keep a photo. Please add it again.');
    }
  }

  /**
   * Shows an image whole: what is drawn at once (maybe its thumbnail),
   * then the full photo when it arrives, if the viewer is still open on it.
   */
  private async openViewer(src: string, alt: string, url: string): Promise<void> {
    this.viewing.set({ src, alt });
    this.viewer().nativeElement.showModal();
    if (!url.startsWith('attachment:')) return;
    const full = await this.attachments.full(url.slice('attachment:'.length));
    if (full && this.viewing()?.src === src) this.viewing.set({ src: full, alt });
  }

  /** A click on the dark space around the image closes the viewer. */
  protected closeViewer(event: MouseEvent): void {
    if (event.target === this.viewer().nativeElement) this.viewer().nativeElement.close();
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
