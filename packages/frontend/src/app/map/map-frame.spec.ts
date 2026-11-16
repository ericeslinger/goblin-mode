import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  MAX_ZOOM,
  MIN_LABEL_PX,
  MapFrame,
  ZOOM_STEPS,
  clampZoom,
  readable,
  zoomInFrom,
  zoomOutFrom,
} from './map-frame';
import { boxWidthIs } from '../testing/screen';

@Component({
  imports: [MapFrame],
  template: `<app-map-frame [units]="600"
    ><svg class="map" viewBox="0 0 600 360"></svg
  ></app-map-frame>`,
})
class Host {
  readonly frame = viewChild.required(MapFrame);
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (name: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
  const canvas = () => el.querySelector<HTMLElement>('.canvas')!;
  const press = async (name: string) => {
    button(name).click();
    await fixture.whenStable();
  };
  return { fixture, el, button, canvas, press, frame: fixture.componentInstance.frame() };
}

describe('the zoom steps', () => {
  it('step from Fit to four times and back', () => {
    expect(ZOOM_STEPS[0]).toBe(1);
    const up: number[] = [];
    for (let s = 1; s < MAX_ZOOM; s = zoomInFrom(s)) up.push(zoomInFrom(s));
    expect(up).toEqual([1.5, 2, 3, 4]);
    expect(zoomInFrom(4)).toBe(4);
    expect(zoomOutFrom(4)).toBe(3);
    expect(zoomOutFrom(1.5)).toBe(1);
    expect(zoomOutFrom(1)).toBe(1);
  });

  it('go to the next step from between two, as after a pinch', () => {
    expect(zoomInFrom(1.7)).toBe(2);
    expect(zoomOutFrom(1.7)).toBe(1.5);
  });

  it('keep a pinch between Fit and the last step', () => {
    expect(clampZoom(0.4)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
    expect(clampZoom(9)).toBe(4);
  });

  it('draw a label only at 11 px or more', () => {
    expect(MIN_LABEL_PX).toBe(11);
    // A 14-unit label in a 600-unit drawing on a 380 px box: 8.9 px at
    // Fit, 13.3 px one step in.
    expect(readable(14, 380 / 600)).toBe(false);
    expect(readable(14, (380 * 1.5) / 600)).toBe(true);
    expect(readable(11, 1)).toBe(true);
    expect(readable(14, 0)).toBe(false);
  });
});

describe('MapFrame', () => {
  let restore: () => void;
  beforeEach(() => (restore = boxWidthIs(380)));
  afterEach(() => restore());

  it('fits the box at first, Zoom out and Fit idle', async () => {
    const { button, canvas, frame } = await render();
    expect(frame.scale()).toBe(1);
    expect(canvas().style.width).toBe('');
    expect(frame.pxPerUnit()).toBeCloseTo(380 / 600);
    expect(button('Zoom in').getAttribute('aria-disabled')).toBeNull();
    expect(button('Zoom out').getAttribute('aria-disabled')).toBe('true');
    expect(button('Fit').getAttribute('aria-disabled')).toBe('true');
  });

  it('zooms a step at a time to four times, and Fit goes back', async () => {
    const { button, canvas, press, frame } = await render();
    await press('Zoom in');
    expect(frame.scale()).toBe(1.5);
    expect(canvas().style.width).toBe('570px');
    expect(frame.pxPerUnit()).toBeCloseTo(0.95);
    for (let i = 0; i < 5; i++) await press('Zoom in');
    expect(frame.scale()).toBe(4);
    expect(canvas().style.width).toBe('1520px');
    expect(button('Zoom in').getAttribute('aria-disabled')).toBe('true');
    await press('Zoom out');
    expect(frame.scale()).toBe(3);
    await press('Fit');
    expect(frame.scale()).toBe(1);
    expect(canvas().style.width).toBe('');
  });

  it('zooms from the keyboard with the drawing focused', async () => {
    const { el, fixture, frame } = await render();
    const box = el.querySelector<HTMLElement>('.box')!;
    expect(box.tabIndex).toBe(0);
    expect(box.getAttribute('aria-label')).toBe('Drawing');
    const key = async (k: string) => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      await fixture.whenStable();
    };
    await key('+');
    await key('=');
    expect(frame.scale()).toBe(2);
    await key('-');
    expect(frame.scale()).toBe(1.5);
    await key('0');
    expect(frame.scale()).toBe(1);
  });

  it('names its buttons as a group', async () => {
    const { el } = await render();
    const group = el.querySelector('[role="group"][aria-label="Zoom the drawing"]')!;
    expect([...group.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
      'Zoom in',
      'Zoom out',
      'Fit',
    ]);
  });
});

describe('a mouse drag in the drawing', () => {
  let restore: () => void;
  beforeEach(() => (restore = boxWidthIs(400)));
  afterEach(() => restore());

  function pointer(type: string, x: number, y: number): Event {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    return Object.assign(event, { pointerType: 'mouse', pointerId: 1 });
  }

  it('pans the box, and the click that ends it opens nothing', async () => {
    const { el, press } = await render();
    await press('Zoom in');
    const box = el.querySelector<HTMLElement>('.box')!;
    const svg = el.querySelector('svg')!;
    // The capture stands in for a real pointer's, which a made event has not.
    box.setPointerCapture = () => undefined;
    box.releasePointerCapture = () => undefined;
    let opened = 0;
    svg.addEventListener('click', () => opened++);

    svg.dispatchEvent(pointer('pointerdown', 200, 100));
    svg.dispatchEvent(pointer('pointermove', 150, 100));
    expect(box.classList.contains('dragging')).toBe(true);
    svg.dispatchEvent(pointer('pointerup', 150, 100));
    expect(box.classList.contains('dragging')).toBe(false);
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened).toBe(0);

    // The next click is an ordinary one.
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened).toBe(1);
  });

  it('leaves a press without a move as a click', async () => {
    const { el } = await render();
    const svg = el.querySelector('svg')!;
    let opened = 0;
    svg.addEventListener('click', () => opened++);
    svg.dispatchEvent(pointer('pointerdown', 200, 100));
    svg.dispatchEvent(pointer('pointermove', 201, 101));
    svg.dispatchEvent(pointer('pointerup', 201, 101));
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened).toBe(1);
  });
});
