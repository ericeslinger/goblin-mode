import { Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../home/icon';
import { sameDay, snoozeChoices } from '@mossgoblin/schema';
import { TIME_ZONE } from '../platform/platform';
import { type PlacedReminder, RemindersService } from './reminders.service';

/** How far a swipe must travel to count as done or snooze. */
export const SWIPE_PX = 80;

const REPEAT_LABEL = { daily: 'daily', weekdays: 'weekdays', weekly: 'weekly' } as const;

/**
 * One reminder: a round tick at the left is Done, a clock at the right
 * opens the snooze choices (#288). A swipe right or left does the same
 * on a touch screen (DESIGN.md, Right Now), never the only way.
 */
@Component({
  selector: 'app-reminder-row',
  imports: [RouterLink, Icon],
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
      <!-- Done is the round tick at the left, Snooze the clock at the
           right (#288, 2026-11-15): one line of text has the rest. -->
      <button
        type="button"
        class="tick touch-target"
        [attr.aria-label]="'Done: ' + r.text"
        title="Done"
        (click)="done()"
      >
        <app-icon name="check" [size]="16" />
      </button>
      <span class="what">
        @if (r.noteId) {
          <a class="text" [routerLink]="['/n', r.noteId]" [queryParams]="{ from: 'reminder' }">{{
            r.text
          }}</a>
        } @else {
          <span class="text">{{ r.text }}</span>
        }
        @if (r.createdBy === 'claude') {
          <span
            class="glyph"
            role="img"
            [attr.aria-label]="'from ' + (r.agent ?? 'Claude')"
            [title]="'From ' + (r.agent ?? 'Claude')"
            >✳</span
          >
        }
        @if (when()) {
          <span class="when">{{ when() }}</span>
        }
      </span>
      <button
        type="button"
        class="snooze-toggle touch-target"
        [attr.aria-label]="'Snooze: ' + r.text"
        [attr.aria-expanded]="menuOpen()"
        title="Snooze"
        (click)="menuOpen.set(!menuOpen())"
      >
        <app-icon name="clock" [size]="20" />
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
      gap: 10px;
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
    .tick,
    .snooze-toggle {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: 50%;
      background: transparent;
    }
    /* A ring, in the quiet ink so it reads as a control (3:1 and more),
       the tick inside it faint until hovered or focused. */
    .tick {
      width: 28px;
      height: 28px;
      border: 2px solid var(--quiet);
    }
    .tick app-icon {
      opacity: 0.4;
    }
    .tick:hover app-icon,
    .tick:focus-visible app-icon {
      opacity: 1;
    }
    .snooze-toggle {
      width: 32px;
      height: 32px;
      border: 0;
    }
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
    /* Under the text, past the tick. */
    .snooze {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 0 0 12px 38px;
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
