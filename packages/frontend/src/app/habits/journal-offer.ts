import { Component, inject } from '@angular/core';
import { JournalHabitsService } from './journal-habits.service';

/**
 * The quiet offer on the Habits screen (step 7 of #324, 2026-11-22): a
 * feelings journal whose daily reminders are still reminders, said in
 * a line, with Make them habits (the move, `JournalHabitsService`) and
 * Keep them reminders, which puts the offer away for good on this
 * device. Never a move without the tap. Empty, it takes no room. It
 * says what changes (review of #333, 2026-11-22): the nudge, once and
 * only if not logged, opens Right Now, where the reminder's push
 * opened the entry; and a time the quiet hours hold or silence.
 */
@Component({
  selector: 'app-journal-offer',
  template: `
    @for (o of journals.offers(); track o.template.id) {
      <section class="offer" aria-label="Feelings journal reminders">
        <p>{{ o.message }}</p>
        <p class="which">
          @for (r of o.reminders; track r.id; let last = $last) {
            {{ r.recurrence?.time }} {{ r.text
            }}{{ o.nudges[r.id] ? ' (' + o.nudges[r.id] + ')' : '' }}{{ last ? '' : ' · ' }}
          }
        </p>
        <p class="which">
          Each becomes a daily habit at the same time, nudging you once then if it is not logged
          yet. The nudge opens Right Now, where ticking the habit opens a new entry; a reminder's
          push opened the entry itself. Your entries and the journal stay as they are.
        </p>
        @if (o.failed) {
          <p class="which" role="status">
            Not moved yet: making habits needs a connection. Try again when you are online.
          </p>
        }
        <div class="actions">
          <button type="button" class="primary" [disabled]="o.moving" (click)="journals.accept(o)">
            {{
              o.moving
                ? o.reminders.length === 1
                  ? 'Making it a habit…'
                  : 'Making them habits…'
                : o.reminders.length === 1
                  ? 'Make it a habit'
                  : 'Make them habits'
            }}
          </button>
          <button type="button" class="link" (click)="journals.dismiss(o)">
            {{ o.reminders.length === 1 ? 'Keep it a reminder' : 'Keep them reminders' }}
          </button>
        </div>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .offer {
      margin: 8px 0 12px;
      padding: 12px;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
    }
    p {
      margin: 0 0 6px;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .which {
      font-size: 14px;
      color: var(--quiet);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
      margin-top: 8px;
    }
  `,
})
export class JournalOfferLine {
  protected readonly journals = inject(JournalHabitsService);
}
