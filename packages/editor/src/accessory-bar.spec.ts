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

describe('createAccessoryBar', () => {
  it('runs an action a frame after pointerdown, without blurring the editor', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createNoteEditor({ parent, text: 'eggs' });
    const run = vi.fn();
    const bar = createAccessoryBar(editor, [{ label: '[[', name: 'Link', run }]);
    const button = bar.element.querySelector('button')!;
    const down = new Event('pointerdown', { cancelable: true });
    button.dispatchEvent(down);
    // Pending Android keys land first, on the next frame.
    expect(run).not.toHaveBeenCalled();
    await new Promise((done) => requestAnimationFrame(done));
    expect(run).toHaveBeenCalledOnce();
    expect(down.defaultPrevented).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Link');
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
    const down = new Event('pointerdown', { cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
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
