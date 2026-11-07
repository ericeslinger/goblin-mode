import { Directive, ElementRef, inject, output, signal } from '@angular/core';

/** How far a swipe must travel to count (as the reminder rows). */
export const SWIPE_PX = 80;

/**
 * A horizontal swipe on an element (#162): `left` or `right` fires past
 * SWIPE_PX, `dx` follows the finger for the row to move with it. A
 * mostly vertical move is a scroll and never a swipe; the click a
 * mouse fires right after a swipe is swallowed, so a swipe ending over
 * a link never opens it. Pointer events, as the reminder rows use.
 */
@Directive({
  selector: '[appSwipe]',
  host: {
    '(pointerdown)': 'down($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'up($event)',
    '(pointercancel)': 'cancel()',
    // A link or image under the finger would start a native drag, which
    // cancels the pointer events mid-swipe (journey on #162).
    '(dragstart)': '$event.preventDefault()',
    '[style.transform]': 'dx() ? "translateX(" + dx() + "px)" : null',
    '[class.swiping]': 'dx() !== 0',
  },
})
export class Swipe {
  readonly left = output<void>();
  readonly right = output<void>();
  readonly dx = signal(0);

  private start: { x: number; y: number; id: number } | null = null;
  private swiped = false;

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    host.addEventListener(
      'click',
      (e) => {
        if (!this.swiped) return;
        this.swiped = false;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }

  protected down(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    this.swiped = false;
  }

  protected move(event: PointerEvent): void {
    if (!this.start || event.pointerId !== this.start.id) return;
    const dx = event.clientX - this.start.x;
    const dy = event.clientY - this.start.y;
    if (this.dx() === 0) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) return;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    }
    this.dx.set(dx);
  }

  protected up(event: PointerEvent): void {
    if (!this.start || event.pointerId !== this.start.id) return;
    const dx = this.dx();
    this.cancel();
    if (dx === 0) return;
    this.swiped = true;
    setTimeout(() => (this.swiped = false));
    if (dx >= SWIPE_PX) this.right.emit();
    else if (dx <= -SWIPE_PX) this.left.emit();
  }

  protected cancel(): void {
    this.start = null;
    this.dx.set(0);
  }
}
