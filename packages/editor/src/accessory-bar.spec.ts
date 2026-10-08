import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAccessoryBar,
  KEYBOARD_MIN_PX,
  keyboardGeometry,
  keyboardHeight,
} from './accessory-bar';
import { createNoteEditor } from './editor';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keyboardHeight', () => {
  it('is the window height the visual viewport no longer covers', () => {
    expect(keyboardHeight(800, 500, 0)).toBe(300);
    expect(keyboardHeight(800, 800, 0)).toBe(0);
    expect(keyboardHeight(800, 900, 0)).toBe(0);
    expect(keyboardHeight(800, 450, 50)).toBe(300);
  });

  it('treats small gaps as no keyboard', () => {
    expect(KEYBOARD_MIN_PX).toBeGreaterThan(keyboardHeight(800, 740, 0));
  });
});

describe('keyboardGeometry', () => {
  it('sees a keyboard drawn over the page, which resizes nothing (Android)', () => {
    // interactive-widget=overlays-content: both viewports stay 800 tall.
    expect(keyboardGeometry(800, { height: 800, offsetTop: 0 }, 300)).toEqual({
      height: 300,
      bottom: 500,
    });
  });

  it('sees a keyboard that shrinks the visual viewport (Safari)', () => {
    expect(keyboardGeometry(800, { height: 450, offsetTop: 50 }, 0)).toEqual({
      height: 300,
      bottom: 500,
    });
  });

  it('sees no keyboard when neither says so', () => {
    expect(keyboardGeometry(800, { height: 800, offsetTop: 0 }, 0).height).toBe(0);
    expect(keyboardGeometry(800, null, 0)).toEqual({ height: 0, bottom: 800 });
  });
});

const frame = () => new Promise((done) => requestAnimationFrame(done));
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A pointer event as a touch sends it; jsdom has no PointerEvent. */
function pointer(type: string, x = 0, y = 0): Event {
  const event = new MouseEvent(type, { cancelable: true, bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

function setup(items: Parameters<typeof createAccessoryBar>[1], holdMs?: number) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const editor = createNoteEditor({ parent, text: 'eggs' });
  const bar = createAccessoryBar(editor, items, window, { holdMs });
  return { editor, bar, button: bar.element.querySelector('button')! };
}

describe('createAccessoryBar', () => {
  it('runs an action a frame after a tap, without blurring the editor', async () => {
    const run = vi.fn();
    const { editor, bar, button } = setup([{ label: '[[', name: 'Link', run }]);
    const down = pointer('pointerdown');
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    button.dispatchEvent(pointer('pointerup'));
    // Pending Android keys land first, on the next frame.
    expect(run).not.toHaveBeenCalled();
    await frame();
    expect(run).toHaveBeenCalledOnce();
    expect(button.getAttribute('aria-label')).toBe('Link');
    bar.destroy();
    editor.destroy();
  });

  it('presses nothing when the finger scrolls the row (2026-10-08)', async () => {
    const run = vi.fn();
    const { editor, bar, button } = setup([{ label: '[[', name: 'Link', run }]);
    // A drag that starts on the button: a wander past the slop, or the
    // browser taking the pan.
    button.dispatchEvent(pointer('pointerdown', 10, 10));
    button.dispatchEvent(pointer('pointermove', 30, 12));
    button.dispatchEvent(pointer('pointerup', 30, 12));
    button.dispatchEvent(pointer('pointerdown', 10, 10));
    button.dispatchEvent(pointer('pointercancel', 10, 10));
    await frame();
    expect(run).not.toHaveBeenCalled();
    // A small wobble is still a tap.
    button.dispatchEvent(pointer('pointerdown', 10, 10));
    button.dispatchEvent(pointer('pointermove', 14, 12));
    button.dispatchEvent(pointer('pointerup', 14, 12));
    await frame();
    expect(run).toHaveBeenCalledOnce();
    bar.destroy();
    editor.destroy();
  });

  it("offers a group's choices on a hold, and keeps the one picked", async () => {
    const task = vi.fn();
    const bullet = vi.fn();
    const { editor, bar, button } = setup(
      [
        {
          name: 'Lists',
          actions: [
            { label: '☐', name: 'Checklist item', run: task },
            { label: '•', name: 'Bulleted list', run: bullet },
          ],
        },
      ],
      20,
    );
    expect(button.getAttribute('aria-label')).toBe('Checklist item');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    // A tap runs the choice shown.
    button.dispatchEvent(pointer('pointerdown'));
    button.dispatchEvent(pointer('pointerup'));
    await frame();
    expect(task).toHaveBeenCalledOnce();
    // A hold opens the menu instead, and the lift runs nothing.
    button.dispatchEvent(pointer('pointerdown'));
    await wait(40);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.getAttribute('aria-label')).toBe('Lists');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.dispatchEvent(pointer('pointerup'));
    button.dispatchEvent(new MouseEvent('click', { detail: 1 }));
    await frame();
    expect(task).toHaveBeenCalledOnce();
    const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    expect([...items].map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['☐Checklist item', 'true'],
      ['•Bulleted list', 'false'],
    ]);
    // Picking runs it, closes the menu, and makes it the button's choice.
    items[1]!.dispatchEvent(new MouseEvent('click', { detail: 1 }));
    await frame();
    expect(bullet).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Bulleted list');
    button.dispatchEvent(pointer('pointerdown'));
    button.dispatchEvent(pointer('pointerup'));
    await frame();
    expect(bullet).toHaveBeenCalledTimes(2);
    expect(task).toHaveBeenCalledOnce();
    bar.destroy();
    editor.destroy();
  });

  it('closes an open menu on a tap elsewhere, and when the bar hides', async () => {
    const { editor, bar, button } = setup(
      [{ name: 'Insert', actions: [{ label: '+', name: 'Insert image', run: vi.fn() }] }],
      20,
    );
    button.dispatchEvent(pointer('pointerdown'));
    await wait(40);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    editor.view.contentDOM.dispatchEvent(pointer('pointerdown'));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    button.dispatchEvent(pointer('pointerdown'));
    await wait(40);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    bar.update();
    expect(bar.element.hidden).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    bar.destroy();
    editor.destroy();
  });

  it('shows above a keyboard only the VirtualKeyboard API reports', () => {
    const vk = Object.assign(new EventTarget(), {
      overlaysContent: false,
      boundingRect: new DOMRect(0, 0, 0, 0),
    });
    Object.defineProperty(navigator, 'virtualKeyboard', { value: vk, configurable: true });
    try {
      const parent = document.createElement('div');
      document.body.append(parent);
      const editor = createNoteEditor({ parent });
      const covered = vi.spyOn(editor, 'setCoveredFrom');
      const bar = createAccessoryBar(editor, [{ label: 'B', run: () => undefined }]);
      expect(vk.overlaysContent).toBe(true);
      editor.view.focus();
      vk.dispatchEvent(new Event('geometrychange'));
      expect(bar.element.hidden).toBe(true);
      vk.boundingRect = new DOMRect(0, innerHeight - 300, innerWidth, 300);
      vk.dispatchEvent(new Event('geometrychange'));
      expect(bar.element.hidden).toBe(false);
      // The editor keeps its line above the bar's top.
      expect(covered).toHaveBeenLastCalledWith(innerHeight - 300 - bar.element.offsetHeight);
      vk.boundingRect = new DOMRect(0, 0, 0, 0);
      vk.dispatchEvent(new Event('geometrychange'));
      expect(bar.element.hidden).toBe(true);
      expect(covered).toHaveBeenLastCalledWith(undefined);
      bar.destroy();
      expect(vk.overlaysContent).toBe(false);
      editor.destroy();
    } finally {
      delete (navigator as { virtualKeyboard?: unknown }).virtualKeyboard;
    }
  });

  it('runs an immediate action on the click itself, for a file picker', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createNoteEditor({ parent });
    const run = vi.fn();
    const bar = createAccessoryBar(editor, [
      { label: '+', name: 'Insert image', immediate: true, run },
    ]);
    const button = bar.element.querySelector('button')!;
    const down = pointer('pointerdown');
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    button.dispatchEvent(pointer('pointerup'));
    expect(run).not.toHaveBeenCalled();
    button.dispatchEvent(new MouseEvent('click', { detail: 1 }));
    expect(run).toHaveBeenCalledOnce();
    bar.destroy();
    editor.destroy();
  });

  it('stays hidden without an open keyboard', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createNoteEditor({ parent });
    const bar = createAccessoryBar(editor, []);
    bar.update();
    expect(bar.element.hidden).toBe(true);
    // Inline display must not override the hidden state.
    expect(bar.element.style.display).toBe('none');
    bar.destroy();
    editor.destroy();
  });
});
