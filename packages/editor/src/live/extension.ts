// The CodeMirror side of live preview: parse with the one grammar, turn
// the tree into decoration specs, and draw them.
import { type EditorState, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import type { Root } from 'mdast';
import { parseNote } from '../grammar/parse';
import { computeDecorations, type DecorationSpec, type Mode } from './decorations';
import { hooksFacet, type NoteEditorHooks } from './hooks';
import { BulletWidget, CheckboxWidget, ImageWidget, WikiLinkWidget } from './widgets';

export const setMode = StateEffect.define<Mode>();

export const modeField = StateField.define<Mode>({
  create: () => 'live',
  update(mode, tr) {
    for (const effect of tr.effects) if (effect.is(setMode)) mode = effect.value;
    return mode;
  },
});

/** The note's parse, redone on every change (notes are small). */
const treeField = StateField.define<Root>({
  create: (state) => parseNote(state.doc.toString()),
  update: (tree, tr) => (tr.docChanged ? parseNote(tr.newDoc.toString()) : tree),
});

/** Lines the selection touches: shown as typed, so they can be edited. */
export function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let l = first; l <= last; l++) lines.add(l);
  }
  return lines;
}

function toDecoration(spec: DecorationSpec, hooks: NoteEditorHooks): Range<Decoration> {
  switch (spec.kind) {
    case 'line':
      return Decoration.line({ class: spec.className }).range(spec.from);
    case 'mark':
      return Decoration.mark({ class: spec.className }).range(spec.from, spec.to);
    case 'hide':
      return Decoration.replace({}).range(spec.from, spec.to);
    case 'checkbox':
      return Decoration.replace({
        widget: new CheckboxWidget(spec.checked, spec.toggleAt),
      }).range(spec.from, spec.to);
    case 'bullet':
      return Decoration.replace({ widget: new BulletWidget() }).range(spec.from, spec.to);
    case 'wikiLink':
      return Decoration.replace({
        widget: new WikiLinkWidget(spec.target, spec.alias, hooks),
      }).range(spec.from, spec.to);
    case 'image':
      return Decoration.replace({
        widget: new ImageWidget(spec.url, spec.alt, hooks),
      }).range(spec.from, spec.to);
  }
}

function build(state: EditorState): DecorationSet {
  const specs = computeDecorations(
    state.doc.toString(),
    state.field(treeField),
    state.field(modeField),
    activeLines(state),
  );
  const hooks = state.facet(hooksFacet);
  return Decoration.set(
    specs.map((s) => toDecoration(s, hooks)),
    true,
  );
}

const decorationsField = StateField.define<DecorationSet>({
  create: build,
  update(decorations, tr) {
    const modeChanged = tr.effects.some((e) => e.is(setMode));
    return tr.docChanged || tr.selection || modeChanged ? build(tr.state) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Live preview and source modes; switch with the `setMode` effect. */
export function livePreview(initialMode: Mode = 'live') {
  return [modeField.init(() => initialMode), treeField, decorationsField];
}
