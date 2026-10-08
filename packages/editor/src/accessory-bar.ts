// A row of large buttons docked above the on-screen keyboard, for touch
// devices where a floating menu would collide with the native copy and
// paste popover. Ported from overstory's body editor (2026-08), which
// learned two things the hard way:
//
// - The bar shows only while the keyboard is actually open: Android's
//   back button closes the keyboard without blurring the editor.
// - The page asks for `interactive-widget=overlays-content`, so on
//   Android Chrome the keyboard resizes neither viewport and only the
//   VirtualKeyboard API sees it (2026-10-07: the bar never showed on
//   Eric's phone while it watched `visualViewport` alone). Safari has no
//   such API and shrinks the visual viewport instead, so both are read.
// - Buttons prevent the default on `pointerdown`, so a tap never blurs
//   the editor (which would close the keyboard). They act on the tap's
//   end, once the finger has proved it was not scrolling the row
//   (2026-10-08: acting on pointerdown pressed whatever button a drag
//   started on).
//
// Refit (Eric, 2026-10-08): related actions share one button. A tap
// runs the choice it shows; holding it opens the others, and the one
// picked stays as the button's choice. Six buttons fit a 360px phone
// without scrolling.
import type { NoteEditor } from './editor';

export interface AccessoryAction {
  label: string;
  /** Accessible name, when the label is a symbol. */
  name?: string;
  /** How the label looks, e.g. bold for Bold. */
  style?: Partial<Pick<CSSStyleDeclaration, 'fontWeight' | 'fontStyle'>>;
  /** Kept in view at the end when the row scrolls (Hide keyboard). */
  pinned?: boolean;
  /**
   * Runs on the click itself, not a frame after the tap: opening a
   * file picker needs the tap's user activation, which a touch
   * pointerdown does not give (Insert image).
   */
  immediate?: boolean;
  run: () => void;
}

/**
 * Several actions behind one button: the first is its choice until a
 * hold picks another.
 */
export interface AccessoryGroup {
  /** Names the menu of choices, e.g. Lists. */
  name: string;
  actions: AccessoryAction[];
}

export type AccessoryItem = AccessoryAction | AccessoryGroup;

export function isGroup(item: AccessoryItem): item is AccessoryGroup {
  return 'actions' in item;
}

/** How far a finger may wander and still mean a tap, not a scroll. */
export const TAP_SLOP_PX = 10;
/** How long a press is held before a group offers its choices. */
export const HOLD_MS = 450;

/** Keyboard height (px) below which we assume no keyboard is open. */
export const KEYBOARD_MIN_PX = 120;

export function keyboardHeight(windowHeight: number, viewportHeight: number, offsetTop: number) {
  return Math.max(0, windowHeight - viewportHeight - offsetTop);
}

/** The slice of `navigator.virtualKeyboard` (Chromium) the bar uses. */
interface VirtualKeyboard extends EventTarget {
  overlaysContent: boolean;
  readonly boundingRect: DOMRect;
}

export interface KeyboardGeometry {
  /** How tall the keyboard is, either way it shows itself. */
  height: number;
  /** Where the bar's bottom edge goes, in layout-viewport px. */
  bottom: number;
}

/**
 * Where the keyboard is. `overlay` is the height the VirtualKeyboard API
 * reports: a keyboard drawn over the visual viewport without shrinking
 * it. A keyboard that shrinks the viewport instead shows up as the gap
 * between the window and the visual viewport.
 */
export function keyboardGeometry(
  windowHeight: number,
  viewport: { height: number; offsetTop: number } | null,
  overlay: number,
): KeyboardGeometry {
  const vp = viewport ?? { height: windowHeight, offsetTop: 0 };
  const shrunk = keyboardHeight(windowHeight, vp.height, vp.offsetTop);
  return {
    height: Math.max(overlay, shrunk),
    bottom: vp.offsetTop + vp.height - overlay,
  };
}

export interface AccessoryBar {
  readonly element: HTMLElement;
  /** Re-measures the keyboard; called on viewport and focus changes. */
  update(): void;
  destroy(): void;
}

export interface AccessoryBarOptions {
  /** How long a hold is; tests shorten it. */
  holdMs?: number;
}

const STYLE_ID = 'mg-accessory-style';

// Styled once per document, from the editor's --mg-* tokens with
// neutral fallbacks, like the note theme. Buttons are flat and fill the
// row; `touch-action: pan-x` leaves sideways scrolling to the browser
// (needed only when the row is still too wide, e.g. with large text).
const STYLE = `
.mg-accessory-bar {
  position: fixed; left: 0; right: 0; z-index: 10;
  display: flex; gap: 4px; padding: 4px 8px; box-sizing: border-box;
  background: var(--mg-surface, Canvas); color: var(--mg-ink, inherit);
  border-top: 1px solid var(--mg-rule, currentColor);
  overflow-x: auto; scrollbar-width: none; touch-action: pan-x;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.mg-accessory-bar button {
  position: relative; flex: 1 0 48px; min-width: 48px; min-height: 48px;
  padding: 0; font: inherit; font-size: 18px; color: inherit;
  background: transparent; border: 0;
  border-radius: var(--mg-radius-card, 6px); touch-action: pan-x;
}
.mg-accessory-bar button.mg-pressed,
.mg-accessory-bar button[aria-expanded="true"] {
  background: var(--mg-chip-bg, Highlight);
}
.mg-accessory-bar button.mg-pinned {
  position: sticky; right: 0; margin-left: auto;
  background: var(--mg-surface, Canvas);
}
.mg-accessory-bar .mg-more {
  position: absolute; right: 3px; bottom: 1px;
  font-size: 9px; line-height: 1; color: var(--mg-quiet, inherit);
}
.mg-accessory-menu {
  position: fixed; z-index: 11; display: flex; flex-direction: column;
  min-width: 190px; padding: 4px; box-sizing: border-box;
  background: var(--mg-surface, Canvas); color: var(--mg-ink, inherit);
  border: 1px solid var(--mg-rule, currentColor);
  border-radius: var(--mg-radius-card, 6px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.mg-accessory-menu button {
  display: flex; align-items: center; gap: 12px; min-height: 48px;
  padding: 0 12px; font: inherit; text-align: left; color: inherit;
  background: transparent; border: 0;
  border-radius: var(--mg-radius-card, 6px);
}
.mg-accessory-menu button[aria-checked="true"] { background: var(--mg-chip-bg, Highlight); }
.mg-accessory-menu .mg-label { width: 28px; text-align: center; font-size: 18px; }
`;

function ensureStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  doc.head.append(style);
}

/** What a pointer is doing on a button since it went down. */
interface Press {
  id: number;
  x: number;
  y: number;
  /** The hold fired: the group's menu is open, so the lift does nothing. */
  held: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const point = (e: Event) => {
  const p = e as Partial<PointerEvent>;
  return { id: p.pointerId ?? 0, x: p.clientX ?? 0, y: p.clientY ?? 0 };
};

export function createAccessoryBar(
  editor: NoteEditor,
  items: AccessoryItem[],
  win: Window = window,
  options: AccessoryBarOptions = {},
): AccessoryBar {
  const holdMs = options.holdMs ?? HOLD_MS;
  const doc = win.document;
  ensureStyle(doc);
  // One frame on: on Android, CodeMirror holds Enter and Backspace back
  // until the next frame, so a tap right after one acts on the text with
  // it in, not on the line before it.
  const later = (run: () => void) => win.requestAnimationFrame(() => run());
  const bar = doc.createElement('div');
  bar.className = 'mg-accessory-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');
  // Shown and hidden through style.display: an inline `display: flex`
  // would override the `hidden` attribute and keep the bar on screen.
  const show = (visible: boolean) => {
    bar.hidden = !visible;
    bar.style.display = visible ? 'flex' : 'none';
    if (!visible) closeMenu();
  };
  // A long press is a hold here, not a request for the context menu.
  bar.addEventListener('contextmenu', (e) => e.preventDefault());

  let menu: { element: HTMLElement; button: HTMLButtonElement } | undefined;
  const closeMenu = () => {
    if (!menu) return;
    // A keyboard that was in the menu goes back to its button.
    const focused = menu.element.contains(doc.activeElement);
    menu.element.remove();
    menu.button.setAttribute('aria-expanded', 'false');
    if (focused) menu.button.focus();
    menu = undefined;
  };
  // A tap anywhere else closes the menu; before the editor's own
  // handlers, so a tap into the note both closes it and places the caret.
  // The menu's own button is left to its handler, which closes it too
  // (the target there is the label span, not the button).
  const outside = (e: Event) => {
    const target = e.target as Node;
    if (menu && !menu.element.contains(target) && !menu.button.contains(target)) closeMenu();
  };
  doc.addEventListener('pointerdown', outside, true);
  const escape = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && menu) closeMenu();
  };
  doc.addEventListener('keydown', escape);

  /** Runs an action from a tap or a choice: now for a picker, else a frame on. */
  const act = (action: AccessoryAction, event: Event) => {
    if (action.immediate) {
      // The click carries the activation a file picker needs; the lift
      // before it is let go so the click runs it instead.
      if (event.type === 'click') action.run();
    } else later(action.run);
  };

  /** Which action each group's button runs on a tap. */
  const chosen = new Map<AccessoryGroup, number>();
  const showChoice = (button: HTMLButtonElement, action: AccessoryAction) => {
    const label = button.querySelector<HTMLElement>('.mg-label')!;
    label.textContent = action.label;
    Object.assign(label.style, { fontWeight: '', fontStyle: '' }, action.style ?? {});
    button.setAttribute('aria-label', action.name ?? action.label);
  };

  const openMenu = (group: AccessoryGroup, button: HTMLButtonElement, current: () => number) => {
    closeMenu();
    const choose = (index: number) => {
      chosen.set(group, index);
      showChoice(button, group.actions[index]!);
    };
    const element = doc.createElement('div');
    element.className = 'mg-accessory-menu';
    element.setAttribute('role', 'menu');
    element.setAttribute('aria-label', group.name);
    group.actions.forEach((action, index) => {
      const item = doc.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(index === current()));
      const label = doc.createElement('span');
      label.className = 'mg-label';
      label.textContent = action.label;
      label.setAttribute('aria-hidden', 'true');
      if (action.style) Object.assign(label.style, action.style);
      const name = doc.createElement('span');
      name.textContent = action.name ?? action.label;
      item.append(label, name);
      item.addEventListener('pointerdown', (e) => e.preventDefault());
      item.addEventListener('click', (e) => {
        choose(index);
        closeMenu();
        act(action, e);
      });
      element.append(item);
    });
    // Arrow keys walk the choices, Home and End jump; Escape is global.
    element.addEventListener('keydown', (e) => {
      const buttons = [...element.querySelectorAll<HTMLButtonElement>('button')];
      const at = buttons.indexOf(doc.activeElement as HTMLButtonElement);
      const to =
        e.key === 'ArrowDown'
          ? (at + 1) % buttons.length
          : e.key === 'ArrowUp'
            ? (at - 1 + buttons.length) % buttons.length
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? buttons.length - 1
                : -1;
      if (to < 0) return;
      e.preventDefault();
      buttons[to]?.focus();
    });
    doc.body.append(element);
    // Above the bar, starting where the button does, kept on screen.
    const barTop = bar.getBoundingClientRect().top;
    const left = button.getBoundingClientRect().left;
    element.style.top = `${Math.max(0, barTop - element.offsetHeight)}px`;
    element.style.left = `${Math.max(8, Math.min(left, win.innerWidth - element.offsetWidth - 8))}px`;
    button.setAttribute('aria-expanded', 'true');
    menu = { element, button };
  };

  for (const item of items) {
    const button = doc.createElement('button');
    button.type = 'button';
    const label = doc.createElement('span');
    label.className = 'mg-label';
    button.append(label);
    const group = isGroup(item) ? item : undefined;
    const current = () =>
      group ? group.actions[chosen.get(group) ?? 0]! : (item as AccessoryAction);
    if (group) {
      chosen.set(group, 0);
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      // Hold for Lists: the choices, and that there are some.
      button.title = `Hold for ${group.name.toLowerCase()}`;
      const more = doc.createElement('span');
      more.className = 'mg-more';
      more.setAttribute('aria-hidden', 'true');
      more.textContent = '▾';
      button.append(more);
    } else if (!isGroup(item) && item.pinned) button.classList.add('mg-pinned');
    showChoice(button, current());

    let press: Press | undefined;
    let swallowClick = false;
    const release = () => {
      if (press?.timer !== undefined) clearTimeout(press.timer);
      press = undefined;
      button.classList.remove('mg-pressed');
    };
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // A new press: a click the last one meant to swallow never came
      // (the finger slid away, or the browser took the pan).
      swallowClick = false;
      if (menu?.button === button) {
        // A tap on the open menu's button only closes it.
        closeMenu();
        swallowClick = true;
        return;
      }
      release();
      const at = point(e);
      press = { ...at, held: false };
      button.classList.add('mg-pressed');
      // The lift reaches this button even if the finger slid off it.
      try {
        button.setPointerCapture?.(at.id);
      } catch {
        // A synthetic event in tests has no live pointer to capture.
      }
      if (group) {
        press.timer = win.setTimeout(() => {
          if (!press) return;
          press.held = true;
          swallowClick = true;
          button.classList.remove('mg-pressed');
          openMenu(group, button, () => chosen.get(group) ?? 0);
        }, holdMs);
      }
    });
    button.addEventListener('pointermove', (e) => {
      if (!press) return;
      const at = point(e);
      // A finger that wanders this far is scrolling the row.
      if (Math.hypot(at.x - press.x, at.y - press.y) > TAP_SLOP_PX) release();
    });
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerup', (e) => {
      if (!press) return;
      const held = press.held;
      release();
      if (!held) act(current(), e);
    });
    button.addEventListener('click', (e) => {
      if (swallowClick) {
        swallowClick = false;
        return;
      }
      const action = current();
      // A picker opens on the click; keyboard and assistive-tech
      // activation has no pointer sequence at all (detail 0).
      if (action.immediate || (e as MouseEvent).detail === 0) act(action, e);
    });
    button.addEventListener('keydown', (e) => {
      if (group && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ContextMenu')) {
        e.preventDefault();
        openMenu(group, button, () => chosen.get(group) ?? 0);
        menu?.element.querySelector('button')?.focus();
      }
    });
    bar.append(button);
  }
  doc.body.append(bar);
  show(false);

  const vk = (win.navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard;
  // What the viewport meta already asks for; Chromium reports geometry
  // only once the page says it handles an overlaid keyboard itself.
  // Put back on destroy, so no other screen inherits it.
  const overlaid = vk?.overlaysContent;
  if (vk) vk.overlaysContent = true;

  const update = () => {
    const vv = win.visualViewport;
    const focused = editor.view.hasFocus;
    const kb = keyboardGeometry(win.innerHeight, vv, vk?.boundingRect.height ?? 0);
    show(focused && kb.height >= KEYBOARD_MIN_PX);
    if (!bar.hidden) bar.style.top = `${kb.bottom - bar.offsetHeight}px`;
    // The bar and an overlaid keyboard cover the page from the bar's top
    // down: the editor keeps the line being typed above it (2026-10-07,
    // the bar sat on that line in a long note).
    editor.setCoveredFrom(bar.hidden ? undefined : kb.bottom - bar.offsetHeight);
  };

  const vv = win.visualViewport;
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  vk?.addEventListener('geometrychange', update);
  editor.view.contentDOM.addEventListener('focus', update);
  editor.view.contentDOM.addEventListener('blur', update);

  return {
    element: bar,
    update,
    destroy() {
      closeMenu();
      doc.removeEventListener('pointerdown', outside, true);
      doc.removeEventListener('keydown', escape);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      vk?.removeEventListener('geometrychange', update);
      if (vk && overlaid !== undefined) vk.overlaysContent = overlaid;
      editor.view.contentDOM.removeEventListener('focus', update);
      editor.view.contentDOM.removeEventListener('blur', update);
      bar.remove();
      editor.setCoveredFrom(undefined);
    },
  };
}
