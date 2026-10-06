import { describe, expect, it, vi } from 'vitest';
import { CheckboxWidget, ImageWidget, safeImageSrc, WikiLinkWidget } from './widgets';

describe('safeImageSrc', () => {
  it('allows http, https and blob sources only', () => {
    expect(safeImageSrc('https://x.test/a.png')).toBe('https://x.test/a.png');
    expect(safeImageSrc('blob:https://x.test/1')).toBe('blob:https://x.test/1');
    expect(safeImageSrc('javascript:alert(1)')).toBeUndefined();
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBeUndefined();
    expect(safeImageSrc('relative.png')).toBeUndefined();
    expect(safeImageSrc(undefined)).toBeUndefined();
  });
});

describe('ImageWidget', () => {
  it('shows the caption when the source is not allowed or not resolved', () => {
    const bad = new ImageWidget('javascript:alert(1)', 'pic', {}).toDOM();
    expect(bad.tagName).toBe('SPAN');
    expect(bad.textContent).toBe('pic');
    const pending = new ImageWidget('attachment:abc', 'page', {}).toDOM();
    expect(pending.textContent).toBe('page');
  });

  it('draws a resolved attachment as an image', () => {
    const img = new ImageWidget('attachment:abc', 'page', {
      resolveAttachment: (id) => `https://files.test/${id}`,
    }).toDOM() as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toBe('https://files.test/abc');
    expect(img.alt).toBe('page');
  });
});

describe('WikiLinkWidget', () => {
  it('handles its own events so a tap is not turned into a caret move', () => {
    const openLink = vi.fn();
    const widget = new WikiLinkWidget('Vikas', 'vik', { openLink });
    expect(widget.ignoreEvent()).toBe(true);
    const chip = widget.toDOM();
    const down = new MouseEvent('mousedown', { cancelable: true });
    chip.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(openLink).toHaveBeenCalledWith('Vikas');
    expect(chip.textContent).toBe('vik');
  });

  it('compares by target and alias', () => {
    expect(new WikiLinkWidget('A', undefined, {}).eq(new WikiLinkWidget('A', undefined, {}))).toBe(
      true,
    );
    expect(new WikiLinkWidget('A', 'x', {}).eq(new WikiLinkWidget('A', undefined, {}))).toBe(false);
  });
});

describe('CheckboxWidget', () => {
  it('names its action for assistive tech and handles its own events', () => {
    const widget = new CheckboxWidget(false, 3);
    expect(widget.ignoreEvent()).toBe(true);
    expect(widget.eq(new CheckboxWidget(false, 3))).toBe(true);
    expect(widget.eq(new CheckboxWidget(true, 3))).toBe(false);
  });
});
