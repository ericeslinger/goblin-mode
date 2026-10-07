// A row of large buttons docked above the on-screen keyboard, for touch
// devices where a floating menu would collide with the native copy and
// paste popover. Ported from overstory's body editor (2026-08), which
// learned two things the hard way:
//
// - The bar tracks the keyboard through `visualViewport`, and shows only
//   while the keyboard is actually open: Android's back button closes
//   the keyboard without blurring the editor.
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
  run: () => void;
}

/** Keyboard height (px) below which we assume no keyboard is open. */
export const KEYBOARD_MIN_PX = 120;

export function keyboardHeight(windowHeight: number, viewportHeight: number, offsetTop: number) {
  return Math.max(0, windowHeight - viewportHeight - offsetTop);
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
      later(action.run);
    });
    // Keyboard and assistive-tech activation, which has no pointerdown.
    button.addEventListener('click', (e) => {
      if ((e as MouseEvent).detail === 0) later(action.run);
    });
    bar.append(button);
  }
  win.document.body.append(bar);
  show(false);

  const update = () => {
    const vv = win.visualViewport;
    const focused = editor.view.hasFocus;
    const kb = vv ? keyboardHeight(win.innerHeight, vv.height, vv.offsetTop) : 0;
    show(focused && kb >= KEYBOARD_MIN_PX);
    if (!bar.hidden && vv) bar.style.top = `${vv.offsetTop + vv.height - bar.offsetHeight}px`;
  };

  const vv = win.visualViewport;
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  editor.view.contentDOM.addEventListener('focus', update);
  editor.view.contentDOM.addEventListener('blur', update);

  return {
    element: bar,
    update,
    destroy() {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      editor.view.contentDOM.removeEventListener('focus', update);
      editor.view.contentDOM.removeEventListener('blur', update);
      bar.remove();
    },
  };
}
