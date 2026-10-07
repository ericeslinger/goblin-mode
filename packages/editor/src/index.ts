// @mossgoblin/editor: the note grammar plus a CodeMirror 6 editor with live
// preview and source modes. No Angular, no Firebase; see DESIGN.md,
// Editor. Server code should import '@mossgoblin/editor/grammar' instead.
export * from './grammar/index';
export { createNoteEditor, type NoteEditor, type NoteEditorOptions } from './editor';
export {
  createAccessoryBar,
  keyboardGeometry,
  keyboardHeight,
  KEYBOARD_MIN_PX,
  type AccessoryAction,
  type AccessoryBar,
  type KeyboardGeometry,
} from './accessory-bar';
export { computeDecorations, type DecorationSpec, type Mode } from './live/decorations';
export { continueList, insertWikiLink, toggleTaskAt, toggleTaskLine } from './live/commands';
export type { NoteEditorHooks } from './live/hooks';
