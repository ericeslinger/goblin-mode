import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ReadingService } from '../reading/reading.service';
import { FreshLine } from './fresh-line';
import { ReminderRow } from './reminder-row';
import { RemindersService } from './reminders.service';
import { UndoBar } from './undo-bar';

/** Right Now shows at most this many items on the launch screen. */
export const PANEL_ITEMS = 3;

/**
 * Right Now on the launch screen, beside the notes and in the sheet over
 * a saved note: what is overdue or due today, at most three, the rest
 * one tap away on the full list; then what has waited in the reading
 * queue, and one quiet line on what is new in the Reader (#173) and in
 * Podcasts (#251), under the reminders (#288).
 */
@Component({
  selector: 'app-right-now-panel',
  imports: [RouterLink, FreshLine, ReminderRow, UndoBar],
  template: `
    <h2 id="right-now-title">
      <a routerLink="/right-now" class="title">Right Now</a>
    </h2>
    <app-undo-bar />
    @if (shown().length === 0) {
      <p class="muted">Nothing to tend.</p>
    } @else {
      <ul aria-labelledby="right-now-title">
        @for (r of shown(); track r.id) {
          <li><app-reminder-row [reminder]="r" /></li>
        }
      </ul>
    }
    @if (more() > 0) {
      <a routerLink="/right-now" class="more touch-target">{{ more() }} more</a>
    }
    @if (reading.waited().length; as waited) {
      <a routerLink="/reading" class="waited touch-target"
        >{{ waited === 1 ? '1 thing' : waited + ' things' }} saved to read a week ago or more</a
      >
    }
    <app-fresh-line />
  `,
  styles: `
    :host {
      display: block;
    }
    h2 {
      margin: 8px 0;
      font-size: 15px;
    }
    /* Beside the notes list Right Now is capped and scrolls inside
       (#285): its heading stays in sight, so a line cut at the cap
       reads as more below, not as the end. */
    @media (min-width: 900px) {
      h2 {
        position: sticky;
        top: 0;
        z-index: 1;
        margin: 0;
        padding: 12px 0 8px;
        background: var(--bg);
      }
    }
    .title {
      color: var(--ink);
      text-decoration: none;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .muted {
      color: var(--quiet);
    }
    .waited {
      display: block;
      margin-top: 8px;
      color: var(--accent);
    }
    .more {
      display: inline-block;
      margin-top: 8px;
      color: var(--accent);
    }
    /* Room for both links' 44 px tap areas (2026-11-15). */
    @media (pointer: coarse) {
      .more + .waited {
        margin-top: 22px;
      }
    }
  `,
})
export class RightNowPanel {
  protected readonly reading = inject(ReadingService);
  private readonly reminders = inject(RemindersService);
  protected readonly shown = computed(() => this.reminders.due().slice(0, PANEL_ITEMS));
  protected readonly more = computed(() => this.reminders.due().length - this.shown().length);
}
