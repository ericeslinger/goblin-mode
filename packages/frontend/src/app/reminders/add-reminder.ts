import { Component, inject, output, signal } from '@angular/core';
import type { Recurrence } from '@goblin/schema';
import { RemindersService } from './reminders.service';

/** The + form: text, an optional time, and an optional repeat. */
@Component({
  selector: 'app-add-reminder',
  template: `
    <form (submit)="submit($event)" aria-label="New reminder">
      <label>
        Reminder
        <input
          type="text"
          name="text"
          autocomplete="off"
          [value]="text()"
          (input)="text.set(value($event))"
          autofocus
        />
      </label>
      <label>
        When <span class="hint">(leave empty for Someday)</span>
        <input
          type="datetime-local"
          name="when"
          [value]="when()"
          (input)="when.set(value($event))"
        />
      </label>
      <label>
        Repeat
        <select name="repeat" (change)="repeat.set(value($event))">
          <option value="" [selected]="repeat() === ''">Never</option>
          <option value="daily">Daily</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
      @if (repeat() && !when()) {
        <p class="hint">Starts at 9:00 am.</p>
      }
      <div class="actions">
        <button type="submit" class="primary" [disabled]="!text().trim() || !reminders.ready()">
          Add
        </button>
        <button type="button" class="link" (click)="closed.emit()">Cancel</button>
      </div>
    </form>
  `,
  styles: `
    form {
      padding: 8px 0 16px;
      border-bottom: 1px solid var(--rule);
    }
    input,
    select {
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
      color: var(--quiet);
      font-size: 13px;
    }
    .actions {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-top: 12px;
    }
    .primary {
      font: inherit;
      padding: 6px 16px;
      border: 0;
      border-radius: var(--radius-pill);
      color: var(--on-accent);
      background: var(--accent);
      cursor: pointer;
    }
    .primary:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .link {
      border: 0;
      padding: 0;
      font: inherit;
      color: var(--accent);
      background: none;
      cursor: pointer;
    }
  `,
})
export class AddReminder {
  protected readonly reminders = inject(RemindersService);
  readonly closed = output<void>();

  protected readonly text = signal('');
  protected readonly when = signal('');
  protected readonly repeat = signal('');

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.text().trim() || !this.reminders.ready()) return;
    // datetime-local is the device's own local time.
    const due = this.when() ? new Date(this.when()).getTime() : undefined;
    this.reminders.add({
      text: this.text(),
      dueAt: Number.isFinite(due) ? due : undefined,
      repeat: (this.repeat() || undefined) as Recurrence['freq'] | undefined,
    });
    this.closed.emit();
  }
}
