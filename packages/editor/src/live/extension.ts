// The CodeMirror side of live preview: parse with the one grammar, turn
// the tree into decoration specs, and draw them.
import { type EditorState, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view';
import type { Root } from 'mdast';
import { parseNote } from '../grammar/parse';
import { toggleTaskAt } from './commands';
import { computeDecorations, type DecorationSpec, type Mode } from './decorations';
import { hooksFacet, type NoteEditorHooks } from './hooks';
import {
  BulletWidget,
  CheckboxWidget,
  DriveWidget,
  FileWidget,
  ImageWidget,
  WikiLinkWidget,
} from './widgets';

export const setMode = StateEffect.define<Mode>();
/** Draws images again: an attachment's file became available. */
export const refreshImages = StateEffect.define<null>();

export const modeField = StateField.define<Mode>({
  create: () => 'live',
  update(mode, tr) {
    for (const effect of tr.effects) if (effect.is(setMode)) mode = effect.value;
    return mode;
  },
});

/**
 * Viewing (2026-10-17): the note drawn as live preview on every line,
 * the selection included, so a drag selects without turning a line
 * back into source. The host makes the editor not editable alongside.
 */
export const setViewing = StateEffect.define<boolean>();

export const viewingField = StateField.define<boolean>({
  create: () => false,
  update(viewing, tr) {
    for (const effect of tr.effects) if (effect.is(setViewing)) viewing = effect.value;
    return viewing;
  },
  provide: (field) =>
    EditorView.editorAttributes.from(field, (viewing): Record<string, string> =>
      viewing ? { class: 'mg-viewing' } : {},
    ),
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
    case 'file':
      return Decoration.replace({
        widget: new FileWidget(spec.id, spec.name, hooks),
      }).range(spec.from, spec.to);
    case 'drive':
      return Decoration.replace({
        widget: new DriveWidget(spec.url, spec.label),
      }).range(spec.from, spec.to);
  }
}

function build(state: EditorState): DecorationSet {
  const viewing = state.field(viewingField);
  const specs = computeDecorations(
    state.doc.toString(),
    state.field(treeField),
    viewing ? 'live' : state.field(modeField),
    viewing ? new Set() : activeLines(state),
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
    const modeChanged = tr.effects.some(
      (e) => e.is(setMode) || e.is(setViewing) || e.is(refreshImages),
    );
    return tr.docChanged || tr.selection || modeChanged ? build(tr.state) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Where the checkbox on line `pos` is on toggles, if the line holds one
 * the grammar counts as a task (drawn, so only off the edited line).
 */
export function taskToggleOnLine(state: EditorState, pos: number): number | undefined {
  const line = state.doc.lineAt(pos);
  let at: number | undefined;
  state.field(decorationsField).between(line.from, line.to, (from, _to, decoration) => {
    const widget: unknown = decoration.spec.widget;
    if (from >= line.from && widget instanceof CheckboxWidget) {
      at = widget.toggleAt;
      return false;
    }
    return undefined;
  });
  return at;
}

/** A finger that moves less than this between down and up has tapped. */
const TAP_SLOP_PX = 10;

/**
 * While viewing, a tap anywhere on a task's line ticks it (2026-10-17):
 * the box alone is a small target on a phone. A drag (selecting text),
 * or a tap on a widget of its own (the box, a link, a photo), does not.
 */
const tapToTick = ViewPlugin.fromClass(
  class {
    down?: { x: number; y: number };
  },
  {
    eventHandlers: {
      pointerdown(event) {
        this.down = { x: event.clientX, y: event.clientY };
      },
      click(event, view) {
        const down = this.down;
        this.down = undefined;
        if (!view.state.field(viewingField) || view.state.readOnly) return false;
        if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP_SLOP_PX) {
          return false;
        }
        if (!view.state.selection.main.empty) return false;
        const target = event.target as Element | null;
        if (target?.closest?.('input, button, a, img, [role="link"]')) return false;
        const line = target?.closest?.('.cm-line');
        if (!line || !view.contentDOM.contains(line)) return false;
        const at = taskToggleOnLine(view.state, view.posAtDOM(line));
        if (at === undefined) return false;
        view.dispatch(toggleTaskAt(view.state, at));
        return true;
      },
    },
  },
);

/** Live preview and source modes; switch with the `setMode` effect. */
export function livePreview(initialMode: Mode = 'live', initialViewing = false) {
  return [
    modeField.init(() => initialMode),
    viewingField.init(() => initialViewing),
    treeField,
    decorationsField,
    tapToTick,
  ];
}
