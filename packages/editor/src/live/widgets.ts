// The widgets live preview draws in place of markdown syntax.
import { EditorView, WidgetType } from '@codemirror/view';
import { ATTACHMENT_SCHEME } from '../grammar/extract';
import { toggleTaskAt } from './commands';
import type { NoteEditorHooks } from './hooks';

/** Image sources a note may load; the same list renderNoteHtml allows. */
const IMAGE_PROTOCOLS = ['http:', 'https:', 'blob:'];

export function safeImageSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  try {
    return IMAGE_PROTOCOLS.includes(new URL(src).protocol) ? src : undefined;
  } catch {
    return undefined;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly toggleAt: number,
  ) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.toggleAt === this.toggleAt;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'mg-checkbox';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.checked ? 'Mark not done' : 'Mark done');
    // Keep focus and the caret where they are; the edit is ours to make.
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      view.dispatch(toggleTaskAt(view.state, this.toggleAt));
    });
    return box;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export class WikiLinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly alias: string | undefined,
    readonly hooks: NoteEditorHooks,
  ) {
    super();
  }

  override eq(other: WikiLinkWidget): boolean {
    return other.target === this.target && other.alias === this.alias;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'mg-wikilink';
    chip.textContent = this.alias ?? this.target;
    chip.setAttribute('role', 'link');
    chip.setAttribute('tabindex', '0');
    chip.dataset['target'] = this.target;
    const open = () => this.hooks.openLink?.(this.target);
    // Without this, mousedown moves the caret onto the line, the line
    // turns back into source, and the chip is gone before click fires.
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', open);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    return chip;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export class ImageWidget extends WidgetType {
  /**
   * Resolved when the widget is made, so one made after an attachment's
   * file arrives (`refreshImages`) differs and is drawn again.
   */
  readonly src: string | undefined;

  constructor(
    readonly url: string,
    readonly alt: string,
    readonly hooks: NoteEditorHooks,
  ) {
    super();
    this.src = safeImageSrc(
      url.startsWith(ATTACHMENT_SCHEME)
        ? hooks.resolveAttachment?.(url.slice(ATTACHMENT_SCHEME.length))
        : url,
    );
  }

  override eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt && other.src === this.src;
  }

  toDOM(): HTMLElement {
    const src = this.src;
    if (!src) {
      const caption = document.createElement('span');
      caption.className = 'mg-attachment-placeholder';
      caption.textContent = this.alt || 'image';
      return caption;
    }
    const img = document.createElement('img');
    img.className = 'mg-image';
    img.src = src;
    img.alt = this.alt;
    const open = this.hooks.openImage;
    if (open) {
      img.addEventListener('click', (e) => {
        e.preventDefault();
        open(src, this.alt, this.url);
      });
    }
    return img;
  }
}

/** A file kept in the garden (#45), drawn as a chip that opens it. */
export class FileWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly hooks: NoteEditorHooks,
  ) {
    super();
  }

  override eq(other: FileWidget): boolean {
    return other.id === this.id && other.name === this.name;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mg-file';
    chip.textContent = `\u{1F4C4} ${this.name || 'file'}`;
    chip.setAttribute('aria-label', `Open ${this.name || 'file'}`);
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      this.hooks.openFile?.(this.id, this.name);
    });
    return chip;
  }
}

/** A list item's `-`, `*` or `+`, drawn as a bullet off the edited line. */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const bullet = document.createElement('span');
    bullet.className = 'mg-bullet';
    bullet.textContent = '\u2022';
    return bullet;
  }
}
