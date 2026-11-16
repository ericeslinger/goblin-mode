import { type PlaceId, RAIL_PLACES } from '../home/places';

/**
 * The app-wide keys (#289, step 5 of the desktop shell; Eric,
 * 2026-11-15: "a command box on Ctrl/Cmd K, `g` then a letter for
 * modules, `/` to search"). The letters and the guards live here, the
 * listener in ShortcutsService, the box in CommandBox.
 */

/**
 * `g` then one of these goes to the place, from its name: Reader is f
 * (its feeds), r being Right Now's, and Reading queue is q. Every place
 * has one, and no two share a letter (the spec checks).
 */
export const GO_KEYS: Readonly<Record<PlaceId, string>> = {
  home: 'h',
  notes: 'n',
  'right-now': 'r',
  kitchen: 'k',
  reader: 'f',
  podcasts: 'p',
  reading: 'q',
  map: 'm',
  assistants: 'a',
  settings: 's',
};

/** The places in the rail's order, Settings last, as the box lists them. */
export const PLACE_ORDER: readonly PlaceId[] = [...RAIL_PLACES, 'settings'];

/** The place a letter after `g` names, if any. */
export function placeForKey(key: string): PlaceId | undefined {
  return PLACE_ORDER.find((id) => GO_KEYS[id] === key);
}

/** How long `g` waits for its letter. */
export const GO_WAIT_MS = 1500;

/**
 * Where what is typed is text: a field, anything editable, and
 * anything inside the editor (CodeMirror's content, its widgets, its
 * search panel), whose keys are its own whether or not it is in View.
 */
export function editable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor',
  );
}

/**
 * Open things that own the keys while they are open: any modal dialog
 * (the sheets, the image and PDF viewers, the command box itself), the
 * ribbon's menus, the note screen's More and Right Now sheet, and the
 * podcast queue's row menu. Global keys wait until they close.
 */
export const OWNS_KEYS =
  'dialog[open], [role="menu"], #more-menu, #queue-menu, #right-now-sheet:not([hidden])';

/** Keys that only modify the next one, which neither end nor start anything. */
export const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock']);

/** Ctrl K, or Cmd K on a Mac: the command box, and nothing else held. */
export function isBoxChord(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === 'k' &&
    event.ctrlKey !== event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** A key mid-composition (an IME, or Android's keyboards): never ours. */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** One thing the command box can do. */
export interface Command {
  /** Unique, for the option's element id. */
  id: string;
  label: string;
  /** Its key, shown beside it ("g n", "/"). */
  keys?: string;
  run: () => void;
}

/**
 * The commands whose labels hold every word typed, case aside, in the
 * order given; all of them for nothing typed.
 */
export function filterCommands<T extends { label: string }>(all: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter((c) => {
    const label = c.label.toLowerCase();
    return words.every((w) => label.includes(w));
  });
}
