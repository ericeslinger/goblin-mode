// The widgets live preview draws in place of markdown syntax.
import { EditorView, WidgetType } from '@codemirror/view';
import { ATTACHMENT_SCHEME } from '../grammar/extract';
import { toggleTaskAt } from './commands';
import type { NoteEditorHooks } from './hooks';

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
    box.className = 'gm-checkbox';
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
    chip.className = 'gm-wikilink';
    chip.textContent = this.alias ?? this.target;
    chip.setAttribute('role', 'link');
    chip.setAttribute('tabindex', '0');
    chip.dataset['target'] = this.target;
    const open = () => this.hooks.openLink?.(this.target);
    chip.addEventListener('click', open);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    return chip;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly hooks: NoteEditorHooks,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const src = this.url.startsWith(ATTACHMENT_SCHEME)
      ? this.hooks.resolveAttachment?.(this.url.slice(ATTACHMENT_SCHEME.length))
      : this.url;
    if (!src) {
      const caption = document.createElement('span');
      caption.className = 'gm-attachment-placeholder';
      caption.textContent = this.alt || 'image';
      return caption;
    }
    const img = document.createElement('img');
    img.className = 'gm-image';
    img.src = src;
    img.alt = this.alt;
    return img;
  }
}
