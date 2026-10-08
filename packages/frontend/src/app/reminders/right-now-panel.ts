import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ReadingService } from '../reading/reading.service';
import { ReminderRow } from './reminder-row';
import { RemindersService } from './reminders.service';
import { UndoBar } from './undo-bar';

/** Right Now shows at most this many items on the launch screen. */
export const PANEL_ITEMS = 3;

/**
 * Right Now on the launch screen: what is overdue or due today, at most
 * three, the rest one tap away on the full list.
 */
@Component({
  selector: 'app-right-now-panel',
  imports: [RouterLink, ReminderRow, UndoBar],
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
      <a routerLink="/right-now" class="more">{{ more() }} more</a>
    }
    @if (reading.waited().length; as waited) {
      <a routerLink="/reading" class="waited"
        >{{ waited === 1 ? '1 thing' : waited + ' things' }} saved to read a week ago or more</a
      >
    }
  `,
  styles: `
    h2 {
      margin: 8px 0;
      font-size: 15px;
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
  `,
})
export class RightNowPanel {
  protected readonly reading = inject(ReadingService);
  private readonly reminders = inject(RemindersService);
  protected readonly shown = computed(() => this.reminders.due().slice(0, PANEL_ITEMS));
  protected readonly more = computed(() => this.reminders.due().length - this.shown().length);
}
