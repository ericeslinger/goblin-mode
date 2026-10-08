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
// - Buttons act on `pointerdown` with preventDefault, so a tap never
//   blurs the editor (which would close the keyboard).
import type { NoteEditor } from './editor';

export interface AccessoryAction {
  label: string;
  /** Accessible name, when the label is a symbol. */
  name?: string;
  /** How the label looks, e.g. bold for Bold. */
  style?: Partial<Pick<CSSStyleDeclaration, 'fontWeight' | 'fontStyle'>>;
  /** Kept in view at the end when the row scrolls (Done). */
  pinned?: boolean;
  /**
   * Runs on the click itself, not a frame after pointerdown: opening a
   * file picker needs the tap's user activation, which a touch
   * pointerdown does not give (Insert image).
   */
  immediate?: boolean;
  run: () => void;
}

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

export function createAccessoryBar(
  editor: NoteEditor,
  actions: AccessoryAction[],
  win: Window = window,
): AccessoryBar {
  // One frame on: on Android, CodeMirror holds Enter and Backspace back
  // until the next frame, so a tap right after one acts on the text with
  // it in, not on the line before it.
  const later = (run: () => void) => win.requestAnimationFrame(() => run());
  const bar = win.document.createElement('div');
  bar.className = 'mg-accessory-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');
  // Shown and hidden through style.display: an inline `display: flex`
  // would override the `hidden` attribute and keep the bar on screen.
  const show = (visible: boolean) => {
    bar.hidden = !visible;
    bar.style.display = visible ? 'flex' : 'none';
  };
  Object.assign(bar.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    gap: '4px',
    padding: '2px 8px',
    zIndex: '10',
    // More buttons than a narrow phone fits: the row scrolls sideways.
    overflowX: 'auto',
    scrollbarWidth: 'none',
  });

  for (const action of actions) {
    const button = win.document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    if (action.name) button.setAttribute('aria-label', action.name);
    Object.assign(button.style, { minWidth: '48px', minHeight: '48px', flex: '0 0 auto' });
    if (action.style) Object.assign(button.style, action.style);
    if (action.pinned) {
      Object.assign(button.style, {
        position: 'sticky',
        right: '0',
        marginLeft: 'auto',
        background: 'var(--surface, Canvas)',
      });
    }
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!action.immediate) later(action.run);
    });
    button.addEventListener('click', (e) => {
      if (action.immediate) action.run();
      // Keyboard and assistive-tech activation, which has no pointerdown.
      else if ((e as MouseEvent).detail === 0) later(action.run);
    });
    bar.append(button);
  }
  win.document.body.append(bar);
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
