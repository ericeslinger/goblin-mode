import { merge3 } from '@mossgoblin/schema';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  booleanAttribute,
  computed,
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
import { Router } from '@angular/router';
import {
  AttachmentsService,
  STUCK_MS,
  type Transcription,
  captionFor,
} from '../attachments/attachments.service';
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

/** What a file picker offers: photos, or PDFs (#45). */
type FileKind = 'photo' | 'pdf';

interface FormatAction {
  label: string;
  name: string;
  /** The desktop key as the editor binds it (`Mod` is Ctrl, or ⌘ on a Mac). */
  keys?: string;
  style?: { fontWeight?: string; fontStyle?: string };
  /** Runs on the tap itself: it opens a file picker. */
  immediate?: boolean;
  /** `pick` opens a file picker: photos (Insert image) or PDFs (Attach PDF). */
  run: (editor: NoteEditor, pick: (kind: FileKind) => void) => void;
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
  { label: '🖼', name: 'Insert image', immediate: true, run: (_e, pick) => pick('photo') },
  // A PDF (#45), shown as a chip that opens the document viewer.
  { label: '📄', name: 'Attach PDF', immediate: true, run: (_e, pick) => pick('pdf') },
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
    <input #picker type="file" accept="image/*" hidden (change)="picked(picker, 'photo')" />
    <input
      #pdfPicker
      type="file"
      accept="application/pdf"
      hidden
      (change)="picked(pdfPicker, 'pdf')"
    />
    @if (problem(); as message) {
      <p class="note-status" role="alert">{{ message }}</p>
    } @else if (attachments.waiting().size; as count) {
      <p class="note-status" role="status">
        {{ count === 1 ? '1 file' : count + ' files' }} waiting to upload{{
          attachments.struggling() ? '; uploads are failing, still trying' : ''
        }}{{ attachments.inMemory() ? ' (kept only until this page closes)' : '' }}
      </p>
    }
    <dialog
      #viewer
      class="viewer"
      aria-label="Image"
      (close)="viewing.set(undefined); stopTranscription()"
      (click)="closeViewer($event)"
    >
      @if (viewing(); as image) {
        <img [src]="image.src" [alt]="image.alt" />
        <button type="button" class="close" (click)="viewer.close()">Close</button>
        @if (image.id) {
          <div class="transcribe">
            @if (transcription()?.id === image.id) {
              @switch (transcription()!.state.status) {
                @case ('done') {
                  <button type="button" (click)="openTranscript()">Open the transcription</button>
                }
                @case ('failed') {
                  <span role="status">Not transcribed: {{ transcription()!.state.error }}</span>
                  <button type="button" (click)="startTranscription(image.id)">Try again</button>
                }
                @default {
                  <span role="status">Claude is transcribing…</span>
                  @if (stuck()) {
                    <button type="button" (click)="startTranscription(transcription()!.id)">
                      Try again
                    </button>
                  }
                }
              }
            } @else {
              <button type="button" (click)="startTranscription(image.id)">Transcribe</button>
            }
          </div>
        }
      }
    </dialog>
    <dialog
      #fileViewer
      class="viewer document"
      [attr.aria-label]="document()?.name || 'Document'"
      (close)="closeDocument()"
    >
      @if (document(); as doc) {
        <div class="document-bar">
          <span class="document-name">{{ doc.name }}</span>
          @if (doc.url) {
            <a [href]="doc.url" [attr.download]="doc.name">Save</a>
          }
          <button type="button" class="close" (click)="fileViewer.close()">Close</button>
        </div>
        <div class="transcribe">
          @if (transcription()?.id === doc.id) {
            @switch (transcription()!.state.status) {
              @case ('done') {
                <button type="button" (click)="openTranscript()">Open the transcription</button>
              }
              @case ('failed') {
                <span role="status">Not transcribed: {{ transcription()!.state.error }}</span>
                <button type="button" (click)="startTranscription(doc.id)">Try again</button>
              }
              @default {
                <span role="status">Claude is transcribing…</span>
                @if (stuck()) {
                  <button type="button" (click)="startTranscription(transcription()!.id)">
                    Try again
                  </button>
                }
              }
            }
          } @else {
            <button type="button" (click)="startTranscription(doc.id)">Transcribe</button>
          }
        </div>
        @if (openPages()) {
          <form class="document-find" role="search" (submit)="find($event, findBox.value)">
            <label>
              <span class="visually-hidden">Find in this PDF</span>
              <input #findBox type="search" placeholder="Find in this PDF" enterkeyhint="search" />
            </label>
            <button type="submit">Find</button>
            @if (found(); as f) {
              @if (f.pages.length) {
                <span class="found">
                  Page
                  @for (n of f.pages; track n) {
                    <button type="button" class="page-link" (click)="showPage(n)">{{ n }}</button>
                  }
                </span>
              } @else {
                <span class="found">{{
                  f.partial ? 'Not found in the first ' + f.partial + ' pages' : 'Not found'
                }}</span>
              }
            }
          </form>
        }
        @if (doc.status) {
          <p class="document-status" role="status">{{ doc.status }}</p>
        }
        <div #pages class="pages"></div>
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
    .viewer.document[open] {
      display: block;
      overflow-y: auto;
      background: var(--bg);
      color: var(--ink);
    }
    .document-bar {
      position: sticky;
      top: 0;
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2);
      background: var(--surface);
      border-bottom: var(--border) solid var(--rule);
    }
    .document-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .document-bar a {
      color: var(--accent);
    }
    .document-bar .close {
      position: static;
    }
    .document-status {
      padding: var(--space-2);
      color: var(--quiet);
    }
    .transcribe {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      padding: var(--space-1) var(--space-2);
      font-size: 14px;
    }
    .document-find {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-2);
      align-items: center;
      padding: var(--space-1) var(--space-2);
    }
    .document-find input {
      font: inherit;
      font-size: 14px;
      padding: var(--space-1) var(--space-2);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      color: var(--ink);
      background: var(--surface);
    }
    .found {
      font-size: 14px;
    }
    .page-link {
      min-width: 32px;
      min-height: 32px;
      margin-left: 2px;
    }
    .pages {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-2);
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
  /** Moods a Moods line can complete to (#40). */
  readonly suggestMoods = input<(query: string) => string[]>();
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
  protected readonly viewing = signal<{ src: string; alt: string; id?: string } | undefined>(
    undefined,
  );
  /** A transcription asked for from a viewer (#47), and how it goes. */
  protected readonly transcription = signal<{ id: string; state: Transcription } | undefined>(
    undefined,
  );
  private stopWatching?: () => void;
  /** Working for so long the function must have stopped: it may be asked again. */
  protected readonly stuck = computed(() => {
    const state = this.transcription()?.state;
    return (
      state?.status === 'working' &&
      state.startedAt !== undefined &&
      this.clock() - state.startedAt > STUCK_MS
    );
  });
  /**
   * Ticks while a transcription is followed: a stuck record never
   * changes, so time alone must bring Try again (review on #102).
   */
  private readonly clock = signal(Date.now());
  private clockTimer?: ReturnType<typeof setInterval>;
  private readonly router = inject(Router);
  /** Why the last photo could not be attached. */
  protected readonly problem = signal<string | undefined>(undefined);
  private readonly picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');
  private readonly pdfPicker = viewChild.required<ElementRef<HTMLInputElement>>('pdfPicker');
  private readonly fileViewer = viewChild.required<ElementRef<HTMLDialogElement>>('fileViewer');
  private readonly pages = viewChild<ElementRef<HTMLElement>>('pages');
  /** The PDF the viewer holds, let go when it closes. */
  private openDoc?: import('../attachments/pdf-render').OpenPdf;
  /** A PDF is drawn: it can be searched. */
  protected readonly openPages = signal(false);
  /** The pages the last find matched. */
  protected readonly found = signal<{ pages: number[]; partial?: number } | undefined>(undefined);
  /** The document open in the viewer (#45). */
  protected readonly document = signal<
    { id: string; name: string; url?: string; status?: string } | undefined
  >(undefined);
  private readonly viewer = viewChild.required<ElementRef<HTMLDialogElement>>('viewer');
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private editor?: NoteEditor;
  private bar?: AccessoryBar;
  /** What `load` showed ahead of the inputs, so they do not show it again. */
  private loaded?: { id: string; text: string };
  /** The note the editor holds. */
  private shownId?: string;

  constructor() {
    // Pasting or dropping files puts them in the note (#46). Listened for
    // before the editor's own handlers, which would take a paste as text.
    afterNextRender(() => {
      const host = this.host().nativeElement;
      const files = (data: DataTransfer | null) => [...(data?.files ?? [])];
      host.addEventListener(
        'paste',
        (event) => {
          const found = files(event.clipboardData);
          if (!found.length || untracked(this.readOnly)) return;
          // A spreadsheet or chat copy brings text and a picture of it:
          // the text is what was meant (review on #98).
          if (event.clipboardData?.getData('text/plain').trim()) return;
          event.preventDefault();
          event.stopPropagation();
          void this.addFiles(found);
        },
        true,
      );
      host.addEventListener(
        'dragover',
        (event) => {
          if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
        },
        true,
      );
      host.addEventListener(
        'drop',
        (event) => {
          const found = files(event.dataTransfer);
          if (!found.length || untracked(this.readOnly)) return;
          event.preventDefault();
          event.stopPropagation();
          void this.addFiles(found);
        },
        true,
      );
    });
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
        openFile: (id, name) => void this.openDocument(id, name),
        suggestLinks: (query) => untracked(this.suggestLinks)?.(query) ?? [],
        suggestMoods: (query) => untracked(this.suggestMoods)?.(query) ?? [],
        mode: untracked(this.modes.mode),
        onChange: (text) => this.textChange.emit(text),
      });
      this.markReady();
      if (this.touch) {
        const editor = this.editor;
        // The ribbon over the keyboard (#77). Image insert joins it with
        // attachments (M4).
        this.bar = createAccessoryBar(editor, [
          ...FORMAT_ACTIONS.map((action) => ({
            ...action,
            run: () => action.run(editor, (kind) => this.pick(kind)),
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
    action.run(this.editor, (kind) => this.pick(kind));
    if (!action.immediate) this.editor.focus();
  }

  private pick(kind: FileKind): void {
    this.problem.set(undefined);
    (kind === 'pdf' ? this.pdfPicker() : this.picker()).nativeElement.click();
  }

  /**
   * Photos chosen: each goes in the note at the cursor at once, before
   * anything is awaited, so it lands in this note even if another opens
   * meanwhile; then the files are kept on the device.
   */
  protected async picked(input: HTMLInputElement, kind: FileKind = 'photo'): Promise<void> {
    const files = [...(input.files ?? [])];
    input.value = '';
    await this.addFiles(files, () => kind);
  }

  /**
   * Files from elsewhere (#46): pasted, dropped, or shared from another
   * app. A PDF goes in as a file chip, anything else as a photo; what is
   * neither is refused with a reason.
   */
  addFiles(
    files: readonly File[],
    kindOf: (file: File) => FileKind = (f) =>
      f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'pdf' : 'photo',
  ): Promise<void> {
    // Shared files can come before the editor is made.
    return this.ready.then(() => this.insertFiles(files, kindOf));
  }

  private markReady!: () => void;
  private readonly ready = new Promise<void>((done) => (this.markReady = done));

  private async insertFiles(
    files: readonly File[],
    kindOf: (file: File) => FileKind,
  ): Promise<void> {
    const noteId = untracked(this.noteId);
    const shown = this.shownId;
    // What each file really is (a moment's read of its first bytes).
    const looked = await Promise.all(
      files.map(async (f) => [f, kindOf(f), await this.attachments.inspect(f, kindOf(f))] as const),
    );
    if (this.shownId !== shown) {
      this.problem.set('Another note opened before the file went in. Please add it again.');
      return;
    }
    const kept: Promise<void>[] = [];
    for (const [file, kind, found] of looked) {
      if ('error' in found) {
        this.problem.set(found.error);
        continue;
      }
      const id = this.attachments.newId();
      if (kind === 'pdf') this.editor?.insertFile(id, file.name);
      else this.editor?.insertImage(id, captionFor(file.name));
      kept.push(this.attachments.attach(file, id, found.type, noteId));
    }
    this.editor?.focus();
    const results = await Promise.allSettled(kept);
    if (results.some((r) => r.status === 'rejected')) {
      this.problem.set('This device could not keep a file. Please add it again.');
    }
  }

  /**
   * Shows an image whole: what is drawn at once (maybe its thumbnail),
   * then the full photo when it arrives, if the viewer is still open on it.
   */
  private async openViewer(src: string, alt: string, url: string): Promise<void> {
    const id = url.startsWith('attachment:') ? url.slice('attachment:'.length) : undefined;
    this.viewing.set({ src, alt, ...(id ? { id } : {}) });
    this.viewer().nativeElement.showModal();
    if (!url.startsWith('attachment:')) return;
    const full = await this.attachments.full(url.slice('attachment:'.length));
    if (full && this.viewing()?.src === src) this.viewing.set({ ...this.viewing()!, src: full });
  }

  /**
   * Opens a PDF (#45): the device's copy or a download, drawn by pdf.js,
   * which loads only now. Offline and not on this device, it says so.
   */
  private async openDocument(id: string, name: string): Promise<void> {
    this.document.set({ id, name, status: 'Opening…' });
    this.fileViewer().nativeElement.showModal();
    const open = () => this.document()?.id === id;
    const url = await this.attachments.full(id);
    if (!open()) return;
    if (!url) {
      this.document.set({
        id,
        name,
        status: 'This file is not on this device, and it cannot be fetched now.',
      });
      return;
    }
    this.document.set({ id, name, url, status: 'Drawing pages…' });
    try {
      const { openPdf, MAX_PAGES } = await import('../attachments/pdf-render');
      const into = this.pages()?.nativeElement;
      if (!into || !open()) return;
      const pdf = await openPdf(url, into);
      if (!open()) {
        pdf.close();
        return;
      }
      this.openDoc = pdf;
      this.openPages.set(true);
      this.document.set({
        id,
        name,
        url,
        status:
          pdf.pages > MAX_PAGES
            ? `First ${MAX_PAGES} of ${pdf.pages} pages; save it to read the rest.`
            : undefined,
      });
    } catch (err) {
      console.error('could not draw the PDF', err);
      if (open()) {
        this.document.set({
          id,
          name,
          url,
          status: 'This PDF could not be shown here; save it to open it.',
        });
      }
    }
  }

  protected closeDocument(): void {
    this.stopTranscription();
    this.openDoc?.close();
    this.openDoc = undefined;
    this.openPages.set(false);
    this.found.set(undefined);
    this.document.set(undefined);
  }

  /** Asks Claude to transcribe the open photo or PDF (#47). */
  protected startTranscription(id: string): void {
    this.stopTranscription();
    this.transcription.set({ id, state: { status: 'requested' } });
    this.clock.set(Date.now());
    this.clockTimer = setInterval(() => this.clock.set(Date.now()), 30_000);
    this.stopWatching = this.attachments.transcribe(id, (state) => {
      if (this.transcription()?.id === id) this.transcription.set({ id, state });
    });
  }

  protected stopTranscription(): void {
    clearInterval(this.clockTimer);
    this.clockTimer = undefined;
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.transcription.set(undefined);
  }

  /** Opens the note Claude wrote, closing the viewer. */
  protected openTranscript(): void {
    const noteId = this.transcription()?.state.noteId;
    if (!noteId) return;
    this.viewer().nativeElement.close();
    this.fileViewer().nativeElement.close();
    void this.router.navigate(['/n', noteId]);
  }

  /** Finds words in the open PDF (#45), on this device; shows the first page. */
  protected async find(event: Event, query: string): Promise<void> {
    event.preventDefault();
    const doc = this.openDoc;
    if (!doc || !query.trim()) return;
    const pages = await doc.find(query);
    if (doc !== this.openDoc) return;
    // Only laid-out pages are searched: a longer PDF says so (review on #100).
    const { MAX_PAGES } = await import('../attachments/pdf-render');
    this.found.set({ pages, ...(doc.pages > MAX_PAGES ? { partial: MAX_PAGES } : {}) });
    if (pages.length) doc.show(pages[0]);
  }

  protected showPage(n: number): void {
    this.openDoc?.show(n);
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
