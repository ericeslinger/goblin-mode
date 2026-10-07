import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccessoryBar, KEYBOARD_MIN_PX, keyboardHeight } from './accessory-bar';
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
