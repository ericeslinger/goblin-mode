import { Component, computed, inject, input, output, signal } from '@angular/core';
import { dayInitial, dayName, dayState, habitWhen, streakLine } from './habit-lines';
import { type PlacedHabit, HabitsService } from './habits.service';

/**
 * One habit on the Habits screen (#324, step 2): its name, when it is
 * for and its streak as a plain line; the seven days ending today, each
 * a mark and words (never colour alone); today's Done and Skip, each
 * pressed while it is so, and pressed again to clear it; yesterday's
 * too, while it can still be logged; and Edit, for its name, its time
 * and Archive. An archived habit keeps its strip and has Unarchive.
 * Archived or unarchived, it says so (`moved`), so the screen can put
 * the focus where the habit went (review of #328, 2026-11-21).
 */
@Component({
  selector: 'app-habit-card',
  template: `
    @let h = habit();
    <div class="head">
      @if (level() === 3) {
        <h3 [id]="'habit-' + h.id">{{ h.name }}</h3>
      } @else {
        <h2 [id]="'habit-' + h.id">{{ h.name }}</h2>
      }
      @if (!h.archived) {
        <button
          type="button"
          class="quiet"
          [attr.aria-label]="'Edit ' + h.name"
          [attr.aria-expanded]="editing()"
          (click)="editing() ? editing.set(false) : edit()"
        >
          Edit
        </button>
      } @else {
        <button type="button" [attr.aria-label]="'Unarchive ' + h.name" (click)="unarchive()">
          Unarchive
        </button>
      }
    </div>
    @if (meta(); as m) {
      <p class="meta">{{ m }}</p>
    }
    <ol class="strip" [attr.aria-label]="'The last seven days of ' + h.name">
      @for (d of strip(); track d.day) {
        <li [class]="d.state" [title]="d.label">
          <span class="initial" aria-hidden="true">{{ d.initial }}</span>
          <span class="mark" aria-hidden="true">{{ d.mark }}</span>
          <span class="visually-hidden">{{ d.label }}</span>
        </li>
      }
    </ol>
    @if (!h.archived) {
      <div class="log" role="group" [attr.aria-label]="'Today, ' + h.name">
        <span class="when">Today</span>
        @if (settledElsewhere(); as s) {
          <span class="settled">{{ s }}</span>
        } @else {
          <button
            type="button"
            [attr.aria-pressed]="h.today === 'done'"
            [attr.aria-label]="'Done today: ' + h.name"
            (click)="toggle(habits.today(), h.today, 'done')"
          >
            Done
          </button>
          <button
            type="button"
            [attr.aria-pressed]="h.today === 'skipped'"
            [attr.aria-label]="'Skip today: ' + h.name"
            (click)="toggle(habits.today(), h.today, 'skipped')"
          >
            Skip
          </button>
        }
      </div>
      @if (h.yesterdayLoggable) {
        <div class="log" role="group" [attr.aria-label]="'Yesterday, ' + h.name">
          <span class="when">Yesterday</span>
          <button
            type="button"
            [attr.aria-pressed]="h.yesterday === 'done'"
            [attr.aria-label]="'Done yesterday: ' + h.name"
            (click)="toggle(habits.yesterday(), h.yesterday, 'done')"
          >
            Done
          </button>
          <button
            type="button"
            [attr.aria-pressed]="h.yesterday === 'skipped'"
            [attr.aria-label]="'Skip yesterday: ' + h.name"
            (click)="toggle(habits.yesterday(), h.yesterday, 'skipped')"
          >
            Skip
          </button>
        </div>
      }
    }
    @if (editing() && !h.archived) {
      <form class="edit" [attr.aria-label]="'Edit ' + h.name" (submit)="save($event)">
        <label>
          Name
          <input
            type="text"
            name="name"
            autocomplete="off"
            maxlength="80"
            [value]="name()"
            (input)="name.set(value($event))"
          />
        </label>
        <label>
          Time of day <span class="hint">(leave empty for any time)</span>
          <input type="time" name="time" [value]="time()" (input)="time.set(value($event))" />
        </label>
        <div class="actions">
          <button type="submit" class="primary" [disabled]="!name().trim()">Save</button>
          <button type="button" (click)="archive()">Archive</button>
          <button type="button" class="link" (click)="editing.set(false)">Cancel</button>
        </div>
      </form>
    }
  `,
  styles: `
    :host {
      display: block;
      padding: var(--space-3) 0;
      border-bottom: 1px solid var(--rule);
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
    }
    h2,
    h3 {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-size: 17px;
      overflow-wrap: anywhere;
    }
    .meta {
      margin: 2px 0 0;
      font-size: 14px;
      color: var(--quiet);
    }
    .strip {
      display: flex;
      gap: 6px;
      margin: var(--space-2) 0 0;
      padding: 0;
      list-style: none;
    }
    .strip li {
      display: grid;
      justify-items: center;
      gap: 2px;
      width: 30px;
    }
    .initial {
      font-size: 12px;
      color: var(--quiet);
    }
    /* Each day a ring; done filled with the accent; the mark inside
       says the state too, and the words are there for a reader. */
    .mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 26px;
      height: 26px;
      border: 2px solid var(--quiet);
      border-radius: 50%;
      font-size: 14px;
      line-height: 1;
      color: var(--ink);
    }
    .done .mark {
      color: var(--on-accent);
      background: var(--accent);
      border-color: var(--accent);
    }
    .covered .mark,
    .open .mark {
      border-style: dashed;
    }
    .before .mark {
      border-color: var(--rule);
    }
    .strip li:last-child .initial {
      font-weight: 600;
      color: var(--ink);
    }
    .log {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin-top: var(--space-2);
    }
    .log .when {
      min-width: 5.5em;
      font-size: 14px;
      color: var(--quiet);
    }
    .log button {
      font-size: 14px;
      border-radius: var(--radius-pill);
    }
    .log button[aria-pressed='true'] {
      font-weight: 600;
      border-color: var(--accent);
      background: var(--chip-bg);
    }
    .settled {
      font-size: 14px;
    }
    .edit {
      margin-top: var(--space-2);
    }
    .edit input {
      display: block;
      width: 100%;
      box-sizing: border-box;
      margin-top: 4px;
      padding: 8px;
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
    }
    .hint {
      font-size: 13px;
      color: var(--quiet);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      align-items: center;
      margin-top: var(--space-2);
    }
  `,
})
export class HabitCard {
  readonly habit = input.required<PlacedHabit>();
  /** Its heading's level: 2 among the habits, 3 under Archived. */
  readonly level = input(2);
  /** The habit is archived (true) or back (false); this card goes. */
  readonly moved = output<boolean>();
  protected readonly habits = inject(HabitsService);

  protected readonly editing = signal(false);
  protected readonly name = signal('');
  protected readonly time = signal('');

  protected readonly meta = computed(() => {
    const h = this.habit();
    return [
      habitWhen(h),
      ...(h.streak ? [streakLine(h.schedule, h.streak.count, h.streak.complete)] : []),
    ]
      .filter(Boolean)
      .join(' · ');
  });

  protected readonly strip = computed(() => {
    const h = this.habit();
    return h.strip.map((d) => {
      const { mark, words } = dayState(d.state, h.schedule);
      return { ...d, mark, initial: dayInitial(d.day), label: `${dayName(d.day)}: ${words}` };
    });
  });

  /** A weekly or monthly habit settled on another day of its period. */
  protected readonly settledElsewhere = computed(() => {
    const h = this.habit();
    if (h.today || h.state === 'none') return '';
    const period = h.schedule === 'monthly' ? 'month' : 'week';
    return `${h.state === 'done' ? 'Done' : 'Skipped'} this ${period}`;
  });

  /** Opens the form on the habit as it is now. */
  protected edit(): void {
    this.name.set(this.habit().name);
    this.time.set(this.habit().time ?? '');
    this.editing.set(true);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /** Logs the day as `state`, or clears it when it is that already. */
  protected toggle(day: string, now: string | undefined, state: 'done' | 'skipped'): void {
    if (now === state) this.habits.clear(this.habit(), day);
    else this.habits.log(this.habit(), day, state);
  }

  protected save(event: Event): void {
    event.preventDefault();
    const h = this.habit();
    const name = this.name().trim();
    if (!name) return;
    if (name !== h.name) this.habits.rename(h.id, name);
    const time = this.time() || undefined;
    if (time !== h.time) this.habits.setTime(h.id, time);
    this.editing.set(false);
  }

  protected archive(): void {
    this.habits.archive(this.habit().id, true);
    this.editing.set(false);
    this.moved.emit(true);
  }

  protected unarchive(): void {
    this.habits.archive(this.habit().id, false);
    this.moved.emit(false);
  }
}
