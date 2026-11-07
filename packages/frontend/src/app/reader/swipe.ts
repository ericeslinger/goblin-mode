import { Directive, ElementRef, inject, input, output, signal } from '@angular/core';

/** How far a swipe must travel to count (as the reminder rows). */
export const SWIPE_PX = 80;
/** How long the element takes to finish its slide once a swipe counts. */
export const SETTLE_MS = 180;

/**
 * A horizontal swipe on an element (#162): `left` or `right` fires past
 * SWIPE_PX, `dx` follows the finger for the row to move with it. A
 * mostly vertical move is a scroll and never a swipe; the click a
 * mouse fires right after a swipe is swallowed, so a swipe ending over
 * a link never opens it. Pointer events, as the reminder rows use.
 */
@Directive({
  selector: '[appSwipe]',
  exportAs: 'appSwipe',
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
    '[class.settling]': 'settling()',
  },
})
export class Swipe {
  readonly left = output<void>();
  readonly right = output<void>();
  /** Whether a swipe that way has anywhere to go; otherwise it snaps back (review on #169). */
  readonly canLeft = input(true);
  readonly canRight = input(true);
  readonly dx = signal(0);
  /**
   * A swipe that counted finishes its slide off the edge (SETTLE_MS,
   * `.settling` for the transition) before `left` or `right` fires, so
   * what was dragged in is in place when the change lands (Eric,
   * 2026-11-07).
   */
  readonly settling = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  private start: { x: number; y: number; id: number } | null = null;
  private swiped = false;

  constructor() {
    const host = this.host;
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
    if (event.button !== 0 || this.settling()) return;
    // A slider, the player's position (#179), drags itself, not the page.
    if ((event.target as HTMLElement | null)?.closest?.('input[type=range], [data-no-swipe]')) {
      return;
    }
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
    if (Math.abs(dx) < SWIPE_PX) return;
    const sign = dx > 0 ? 1 : -1;
    if (sign > 0 ? !this.canRight() : !this.canLeft()) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finish = () => {
      // The change and the reset in one tick, with no transition: the
      // listener switches what is shown at once, so the story that slid
      // in is in place in the same frame the slide is undone.
      this.settling.set(false);
      this.dx.set(0);
      if (sign > 0) this.right.emit();
      else this.left.emit();
    };
    if (reduced) return finish();
    this.settling.set(true);
    this.dx.set(sign * this.host.clientWidth);
    setTimeout(finish, SETTLE_MS);
  }

  protected cancel(): void {
    // A cancel during the settle changes nothing: the slide finishes.
    if (this.settling()) return;
    this.start = null;
    this.dx.set(0);
  }
}
