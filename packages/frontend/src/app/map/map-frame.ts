import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
  type Signal,
} from '@angular/core';
import { RAIL_QUERY } from '../rail/rail';

/**
 * The zoom steps (#290, 2026-11-16), as multiples of the width that
 * fits the box: 1 is Fit. Zoom in and Zoom out move a step; a pinch
 * moves freely between the first and the last.
 */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** The smallest label drawn, in CSS px of rendered text. */
export const MIN_LABEL_PX = 11;

/** A pinch's scale, kept between Fit and the last step. */
export function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** The first step past `scale`, or the last step. */
export function zoomInFrom(scale: number): number {
  return ZOOM_STEPS.find((s) => s > scale + 1e-6) ?? MAX_ZOOM;
}

/** The last step short of `scale`, or Fit. */
export function zoomOutFrom(scale: number): number {
  return [...ZOOM_STEPS].reverse().find((s) => s < scale - 1e-6) ?? MIN_ZOOM;
}

/**
 * Whether text `fontSize` units tall in the drawing's viewBox renders
 * at least MIN_LABEL_PX tall when a unit is `pxPerUnit` CSS px.
 */
export function readable(fontSize: number, pxPerUnit: number): boolean {
  return fontSize * pxPerUnit >= MIN_LABEL_PX;
}

/**
 * Whether the screen is wide (900 px and up, as the rail's): there the
 * maps keep their drawing first, at the page's width with every label,
 * as before #290. False where matchMedia is missing. Call it in an
 * injection context.
 */
export function wideScreen(): Signal<boolean> {
  const wide = signal(false);
  const query = typeof matchMedia === 'function' ? matchMedia(RAIL_QUERY) : undefined;
  if (query) {
    const onChange = () => wide.set(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    inject(DestroyRef).onDestroy(() => query.removeEventListener?.('change', onChange));
  }
  return wide.asReadonly();
}

/**
 * The map's drawing on a phone (#290, 2026-11-16): a box no taller
 * than 60% of the screen (560 px at most) that scrolls both ways, with
 * the drawing inside it at `scale` times the box's width. Zoom in,
 * Zoom out and Fit are buttons above it, always there, for keyboards,
 * screen readers and the journeys; a two-finger pinch zooms too, and a
 * mouse drags the drawing. With the box focused, + and - zoom and 0
 * fits; the arrows scroll it as any scroll box. Zoom is not animated,
 * so reduced motion has nothing to turn off. A zoom keeps the point at
 * the box's middle (or between the fingers) where it was.
 *
 * The box never holds the page: a drag past its edge carries on into
 * the page as usual (at Fit only a drawing taller than the box scrolls
 * in it, up and down). `pxPerUnit`
 * says how big a viewBox unit is drawn, for the maps to leave out
 * labels too small to read.
 */
@Component({
  selector: 'app-map-frame',
  template: `
    <div class="tools" role="group" aria-label="Zoom the drawing">
      <button type="button" [attr.aria-disabled]="atMax() || null" (click)="zoomIn()">
        Zoom in
      </button>
      <button type="button" [attr.aria-disabled]="atFit() || null" (click)="zoomOut()">
        Zoom out
      </button>
      <button type="button" [attr.aria-disabled]="atFit() || null" (click)="fit()">Fit</button>
    </div>
    <div
      #box
      class="box"
      tabindex="0"
      role="group"
      aria-label="Drawing"
      [attr.data-zoom]="scale()"
      (keydown)="key($event)"
      (pointerdown)="press($event)"
      (pointermove)="drag($event)"
      (pointerup)="release($event)"
      (pointercancel)="release($event)"
    >
      <div class="canvas" [style.width.px]="canvasWidth()"><ng-content /></div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      margin: var(--space-3) 0;
    }
    .tools {
      display: flex;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-bottom: var(--space-2);
    }
    button[aria-disabled='true'] {
      color: var(--quiet);
      cursor: default;
    }
    .box {
      overflow: auto;
      max-height: min(60vh, 560px);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
      /* One finger scrolls the box (and the page past its edges); two
         are the pinch handled here, not the browser's page zoom. */
      touch-action: pan-x pan-y;
    }
    .box:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .box.dragging {
      cursor: grabbing;
    }
  `,
})
export class MapFrame {
  /** The drawing's viewBox width, in its own units. */
  readonly units = input.required<number>();

  private readonly injector = inject(Injector);
  private readonly box = viewChild.required<ElementRef<HTMLElement>>('box');

  /** Times the width that fits the box; 1 is Fit. */
  readonly scale = signal<number>(MIN_ZOOM);
  /** The box's inner width in CSS px, 0 until measured. */
  private readonly boxWidth = signal(0);

  protected readonly atFit = computed(() => this.scale() <= MIN_ZOOM + 1e-6);
  protected readonly atMax = computed(() => this.scale() >= MAX_ZOOM - 1e-6);
  /** The drawing's width: the box's at Fit (as a plain 100%), more when zoomed. */
  protected readonly canvasWidth = computed(() =>
    this.atFit() || !this.boxWidth() ? null : Math.round(this.boxWidth() * this.scale()),
  );
  /** CSS px a viewBox unit is drawn at; 0 until the box is measured. */
  readonly pxPerUnit = computed(() => {
    const units = this.units();
    return units > 0 ? (this.boxWidth() * this.scale()) / units : 0;
  });

  private pinch?: { distance: number; scale: number };
  private pointer?: { id: number; x: number; y: number; left: number; top: number; moved: boolean };
  private swallowClick = false;
  /**
   * Where the last zoom will put the box's scroll once it is redrawn.
   * A second zoom before that (two touchmoves in one frame) starts
   * from here, not from the scroll the first has yet to write.
   */
  private pending?: { left: number; top: number };

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      const box = this.box().nativeElement;
      const measure = () => this.boxWidth.set(box.clientWidth);
      measure();
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(measure);
        observer.observe(box);
        destroy.onDestroy(() => observer.disconnect());
      }
      // Passive: touch-action already keeps the browser's own pinch off.
      const start = (e: TouchEvent) => this.pinchStart(e);
      const move = (e: TouchEvent) => this.pinchMove(e);
      const end = (e: TouchEvent) => {
        if (e.touches.length < 2) this.pinch = undefined;
      };
      box.addEventListener('touchstart', start, { passive: true });
      box.addEventListener('touchmove', move, { passive: true });
      box.addEventListener('touchend', end, { passive: true });
      box.addEventListener('touchcancel', end, { passive: true });
      // After a mouse drag, the click it ends with opens nothing.
      const click = (e: MouseEvent) => {
        if (!this.swallowClick) return;
        this.swallowClick = false;
        e.stopPropagation();
        e.preventDefault();
      };
      box.addEventListener('click', click, true);
      destroy.onDestroy(() => {
        box.removeEventListener('touchstart', start);
        box.removeEventListener('touchmove', move);
        box.removeEventListener('touchend', end);
        box.removeEventListener('touchcancel', end);
        box.removeEventListener('click', click, true);
      });
    });
  }

  zoomIn(): void {
    if (!this.atMax()) this.zoomTo(zoomInFrom(this.scale()));
  }

  zoomOut(): void {
    if (!this.atFit()) this.zoomTo(zoomOutFrom(this.scale()));
  }

  fit(): void {
    if (!this.atFit()) this.zoomTo(MIN_ZOOM);
  }

  protected key(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const act =
      event.key === '+' || event.key === '='
        ? () => this.zoomIn()
        : event.key === '-'
          ? () => this.zoomOut()
          : event.key === '0'
            ? () => this.fit()
            : undefined;
    if (!act) return;
    event.preventDefault();
    act();
  }

  /**
   * Sets the scale, keeping the drawing's point under `at` (px from the
   * box's top left; its middle by default) under it once redrawn.
   */
  private zoomTo(next: number, at?: { x: number; y: number }): void {
    const box = this.box().nativeElement;
    const before = this.scale();
    next = clampZoom(next);
    if (Math.abs(next - before) < 1e-6) return;
    const fx = at?.x ?? box.clientWidth / 2;
    const fy = at?.y ?? box.clientHeight / 2;
    const x = (this.pending?.left ?? box.scrollLeft) + fx;
    const y = (this.pending?.top ?? box.scrollTop) + fy;
    const ratio = next / before;
    this.scale.set(next);
    this.pending = { left: x * ratio - fx, top: y * ratio - fy };
    afterNextRender(
      {
        write: () => {
          const to = this.pending;
          if (!to) return;
          this.pending = undefined;
          box.scrollLeft = to.left;
          box.scrollTop = to.top;
        },
      },
      { injector: this.injector },
    );
  }

  private pinchStart(e: TouchEvent): void {
    if (e.touches.length !== 2) return;
    this.pinch = { distance: spread(e.touches), scale: this.scale() };
  }

  private pinchMove(e: TouchEvent): void {
    if (!this.pinch || e.touches.length !== 2) return;
    const distance = spread(e.touches);
    if (!this.pinch.distance) return;
    const box = this.box().nativeElement.getBoundingClientRect();
    const [a, b] = [e.touches[0], e.touches[1]];
    this.zoomTo(this.pinch.scale * (distance / this.pinch.distance), {
      x: (a.clientX + b.clientX) / 2 - box.left,
      y: (a.clientY + b.clientY) / 2 - box.top,
    });
  }

  /** A mouse drags the drawing; a touch scrolls the box itself. */
  protected press(e: PointerEvent): void {
    // A drag's click that never came is not left to eat the next one.
    this.swallowClick = false;
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const box = this.box().nativeElement;
    this.pointer = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: box.scrollLeft,
      top: box.scrollTop,
      moved: false,
    };
  }

  protected drag(e: PointerEvent): void {
    const p = this.pointer;
    if (!p || p.id !== e.pointerId) return;
    const [dx, dy] = [e.clientX - p.x, e.clientY - p.y];
    const box = this.box().nativeElement;
    if (!p.moved && Math.hypot(dx, dy) < 4) return;
    if (!p.moved) {
      p.moved = true;
      box.classList.add('dragging');
      box.setPointerCapture?.(e.pointerId);
    }
    box.scrollLeft = p.left - dx;
    box.scrollTop = p.top - dy;
  }

  protected release(e: PointerEvent): void {
    const p = this.pointer;
    if (!p || p.id !== e.pointerId) return;
    this.pointer = undefined;
    if (!p.moved) return;
    const box = this.box().nativeElement;
    box.classList.remove('dragging');
    box.releasePointerCapture?.(e.pointerId);
    this.swallowClick = e.type === 'pointerup';
  }
}

function spread(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
