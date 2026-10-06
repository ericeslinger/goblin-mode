import { Facet } from '@codemirror/state';

/**
 * What the host app supplies to the editor. Kept to small callbacks so
 * the package never imports Firebase or Angular.
 */
export interface NoteEditorHooks {
  /** A wiki link chip was tapped. */
  openLink?: (target: string) => void;
  /** Turns an attachment id into an image URL, if it is available. */
  resolveAttachment?: (id: string) => string | undefined;
}

export const hooksFacet = Facet.define<NoteEditorHooks, NoteEditorHooks>({
  combine: (values) => Object.assign({}, ...values),
});
