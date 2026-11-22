import { Component, inject } from '@angular/core';
import { HabitsService } from './habits.service';

/**
 * A habit write the server refused (review of #327, 2026-11-21), said
 * where habits show, as the note key line says a refused write: plain
 * words naming the habit and the day, Try again (the same write, sent
 * again) and Dismiss. Empty, it takes no room.
 *
 * Under them, in the same words' style, an answer held on this device
 * for the note key and let go because its day was changed elsewhere
 * (review of #332, 2026-11-22), with Dismiss.
 */
@Component({
  selector: 'app-habit-refusals',
  template: `
    <div role="alert" class="refused">
      @for (r of habits.refusals(); track r.key) {
        <p>
          <span>{{ r.message }}</span>
          <button
            type="button"
            class="link"
            [attr.aria-label]="'Try again: ' + r.name"
            (click)="habits.retry(r.key)"
          >
            Try again
          </button>
          <button
            type="button"
            class="link"
            [attr.aria-label]="'Dismiss: ' + r.name"
            (click)="habits.dismiss(r.key)"
          >
            Dismiss
          </button>
        </p>
      }
      @for (l of habits.lostAnswers(); track l.key) {
        <p>
          <span>{{ l.message }}</span>
          <button
            type="button"
            class="link"
            [attr.aria-label]="'Dismiss: your answer for ' + l.name"
            (click)="habits.dismissLost(l.key)"
          >
            Dismiss
          </button>
        </p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .refused:empty {
      display: none;
    }
    p {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin: 0;
      padding: 6px 0;
      font-size: 14px;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
  `,
})
export class HabitRefusals {
  protected readonly habits = inject(HabitsService);
}
