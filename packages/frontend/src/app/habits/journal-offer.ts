import { Component, inject } from '@angular/core';
import { JournalHabitsService } from './journal-habits.service';

/**
 * The quiet offer on the Habits screen (step 7 of #324, 2026-11-22): a
 * feelings journal whose daily reminders are still reminders, said in
 * a line, with Make them habits (the move, `JournalHabitsService`) and
 * Keep them reminders, which puts the offer away for good on this
 * device. Never a move without the tap. Empty, it takes no room.
 */
@Component({
  selector: 'app-journal-offer',
  template: `
    @for (o of journals.offers(); track o.template.id) {
      <section class="offer" aria-label="Feelings journal reminders">
        <p>{{ o.message }}</p>
        <p class="which">
          @for (r of o.reminders; track r.id; let last = $last) {
            {{ r.recurrence?.time }} {{ r.text }}{{ last ? '' : ' · ' }}
          }
        </p>
        <p class="which">
          Each becomes a daily habit at the same time that opens a new entry, with a nudge if it is
          not done by then. Your entries and the journal stay as they are.
        </p>
        <div class="actions">
          <button type="button" class="primary" (click)="journals.accept(o)">
            {{ o.reminders.length === 1 ? 'Make it a habit' : 'Make them habits' }}
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
