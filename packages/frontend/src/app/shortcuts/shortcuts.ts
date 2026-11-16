import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';
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
 * Input types that take no typed text: a key on one of them is a key,
 * not a character (#313, 2026-11-16). Any other type, a missing or
 * unknown one included (the browser makes it text), is a field.
 */
const NOT_TYPED = new Set([
  'checkbox',
  'radio',
  'range',
  'button',
  'submit',
  'reset',
  'file',
  'color',
  'image',
  'hidden',
]);

/** Text whatever its kind: what `editable` takes besides the inputs. */
const TEXT_PLACES =
  'textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor';

/**
 * Where what is typed is text: a text field of any kind, a text area,
 * a select (its type-ahead), anything editable, and anything inside
 * the editor (CodeMirror's content, its widgets, its search panel),
 * whose keys are its own whether or not it is in View. A checkbox,
 * radio, range or button is not (#313): `/` and `g` work from them,
 * and no letter does anything native there to lose.
 */
export function editable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(TEXT_PLACES)) return true;
  const input = target.closest('input');
  return !!input && !NOT_TYPED.has(input.type);
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

/**
 * Whether this is an Apple platform (a Mac, an iPhone, an iPad or an
 * iPod), whose keyboards name Cmd where others name Ctrl. iPadOS says
 * it is a Mac, which is right here too.
 */
export function applePlatform(nav: Navigator | undefined): boolean {
  const data = (nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData;
  return /mac|iphone|ipad|ipod/i.test(data?.platform || nav?.platform || '');
}

/** Whether the keys are an Apple keyboard's: Cmd K, not Ctrl K, is the box. */
export const APPLE = new InjectionToken<boolean>('Apple platform', {
  providedIn: 'root',
  factory: () => applePlatform(inject(DOCUMENT).defaultView?.navigator),
});

/**
 * The command box's chord, and nothing else held: Cmd K on an Apple
 * platform and Ctrl K elsewhere, never both (#313, 2026-11-16), so a
 * Mac's Ctrl K stays a field's kill-line. A held key's repeats are
 * the chord too; the callers take them without opening or closing.
 */
export function isBoxChord(event: KeyboardEvent, apple: boolean): boolean {
  return (
    event.key.toLowerCase() === 'k' &&
    event.metaKey === apple &&
    event.ctrlKey !== apple &&
    !event.altKey &&
    !event.shiftKey
  );
}

/**
 * The letter of a key for `g` and the letter after it, Caps Lock aside
 * (#313, 2026-11-16): `event.key` lower-cased, the letter printed on
 * the key on any layout (AZERTY, Dvorak), not `event.code`, which
 * names a QWERTY place. Held with Shift it is no letter of ours (a
 * capital typed on purpose), Caps Lock on or off.
 */
export function plainLetter(event: KeyboardEvent): string | undefined {
  return event.shiftKey ? undefined : event.key.toLowerCase();
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
