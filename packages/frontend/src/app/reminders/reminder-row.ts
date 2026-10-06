import { Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { sameDay, snoozeChoices } from '@goblin/schema';
import { TIME_ZONE } from '../platform/platform';
import { type PlacedReminder, RemindersService } from './reminders.service';

/** How far a swipe must travel to count as done or snooze. */
export const SWIPE_PX = 80;

const REPEAT_LABEL = { daily: 'daily', weekdays: 'weekdays', weekly: 'weekly' } as const;

/**
 * One reminder: swipe right for done, left for snooze (DESIGN.md, Right
 * Now). The Done and Snooze buttons do the same for keyboards, screen
 * readers and wide screens.
 */
@Component({
  selector: 'app-reminder-row',
  imports: [RouterLink],
  template: `
    @let r = reminder();
    <div
      class="row"
      [class.swiping]="dx() !== 0"
      [style.transform]="dx() ? 'translateX(' + dx() + 'px)' : null"
      (pointerdown)="down($event)"
      (pointermove)="move($event)"
      (pointerup)="up($event)"
      (pointercancel)="cancel()"
    >
      <span class="what">
        @if (r.noteId) {
          <a class="text" [routerLink]="['/']" [queryParams]="{ note: r.noteId }">{{ r.text }}</a>
        } @else {
          <span class="text">{{ r.text }}</span>
        }
        @if (r.createdBy === 'claude') {
          <span class="glyph" role="img" aria-label="from Claude" title="From Claude">✳</span>
        }
        @if (when()) {
          <span class="when">{{ when() }}</span>
        }
      </span>
      <button type="button" class="act" [attr.aria-label]="'Done: ' + r.text" (click)="done()">
        Done
      </button>
      <button
        type="button"
        class="act"
        [attr.aria-label]="'Snooze: ' + r.text"
        [attr.aria-expanded]="menuOpen()"
        (click)="menuOpen.set(!menuOpen())"
      >
        Snooze
      </button>
    </div>
    @if (menuOpen()) {
      <div class="snooze" role="group" [attr.aria-label]="'Snooze ' + r.text + ' until'">
        @for (c of choices(); track c.label) {
          <button type="button" class="pill" (click)="snooze(c.at)">{{ c.label }}</button>
        }
        <form class="pick" (submit)="snoozePicked($event)">
          <label>
            Pick a time
            <input type="datetime-local" [value]="picked()" (input)="pickInput($event)" />
          </label>
          <button type="submit" class="pill" [disabled]="!picked()">Snooze until then</button>
        </form>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      border-bottom: 1px solid var(--rule);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      background: var(--bg);
      touch-action: pan-y;
      user-select: none;
    }
    .row.swiping {
      transition: none;
    }
    .row:not(.swiping) {
      transition: transform var(--motion) ease-out;
    }
    .what {
      flex: 1;
      min-width: 0;
    }
    .text {
      color: var(--ink);
    }
    a.text {
      text-decoration: underline;
      text-decoration-color: var(--rule);
    }
    .glyph {
      margin-left: 4px;
      color: var(--accent);
    }
    .when {
      display: block;
      font-size: 13px;
      color: var(--quiet);
    }
    .act,
    .pill {
      font: inherit;
      font-size: 14px;
      padding: 6px 10px;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-pill);
      color: var(--ink);
      background: transparent;
      cursor: pointer;
    }
    .snooze {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 0 0 12px;
    }
    .pick {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 8px;
    }
    .pick label {
      margin: 0;
      font-size: 14px;
    }
    .pick input {
      display: block;
      font: inherit;
    }
  `,
})
export class ReminderRow {
  readonly reminder = input.required<PlacedReminder>();
  private readonly reminders = inject(RemindersService);
  private readonly tz = inject(TIME_ZONE);

  protected readonly menuOpen = signal(false);
  protected readonly picked = signal('');
  protected readonly dx = signal(0);
  protected readonly choices = computed(() => snoozeChoices(this.reminders.clock(), this.tz));

  /** "9:00 PM", or with the day when not today; "snoozed" and repeats noted. */
  protected readonly when = computed(() => {
    const r = this.reminder();
    if (r.due === undefined) return r.recurrence ? REPEAT_LABEL[r.recurrence.freq] : '';
    const today = sameDay(r.due, this.reminders.clock(), this.tz);
    const time = new Intl.DateTimeFormat(undefined, {
      timeZone: this.tz,
      ...(today ? {} : { weekday: 'short', month: 'short', day: 'numeric' }),
      hour: 'numeric',
      minute: '2-digit',
    }).format(r.due);
    const parts = [r.status === 'snoozed' ? `snoozed until ${time}` : time];
    if (r.recurrence) parts.push(REPEAT_LABEL[r.recurrence.freq]);
    return parts.join(' · ');
  });

  private start: { x: number; y: number; id: number } | null = null;
  private swiped = false;

  constructor() {
    // Capture phase, so a swipe ending over the note link never opens it.
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    host.addEventListener('click', (e) => this.swallowClickAfterSwipe(e), true);
  }

  protected done(): void {
    this.menuOpen.set(false);
    this.reminders.done(this.reminder());
  }

  protected snooze(at: number): void {
    this.menuOpen.set(false);
    this.reminders.snooze(this.reminder(), at);
  }

  protected pickInput(event: Event): void {
    this.picked.set((event.target as HTMLInputElement).value);
  }

  protected snoozePicked(event: Event): void {
    event.preventDefault();
    // datetime-local is the device's own local time.
    const at = new Date(this.picked()).getTime();
    if (Number.isFinite(at)) this.snooze(at);
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
      // Mostly vertical: a scroll, not a swipe.
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
    // Only the click a mouse fires right after this pointerup is the
    // swipe's; touch fires none, so the flag must not outlive this task.
    this.swiped = true;
    setTimeout(() => (this.swiped = false));
    if (dx >= SWIPE_PX) this.done();
    else if (dx <= -SWIPE_PX) this.menuOpen.set(true);
  }

  protected cancel(): void {
    this.start = null;
    this.dx.set(0);
  }

  private swallowClickAfterSwipe(event: Event): void {
    if (!this.swiped) return;
    this.swiped = false;
    event.preventDefault();
    event.stopPropagation();
  }
}
