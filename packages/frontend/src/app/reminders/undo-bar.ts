import { Component, inject } from '@angular/core';
import { RemindersService } from './reminders.service';

/** "Done · Undo" for a few seconds after done or snooze. */
@Component({
  selector: 'app-undo-bar',
  template: `
    <div role="status" class="status">
      @if (reminders.undoable(); as last) {
        <span>{{ last.message }}</span>
        <button type="button" class="link" (click)="reminders.undo()">Undo</button>
      }
    </div>
  `,
  styles: `
    .status:empty {
      display: none;
    }
    .status {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 6px 0;
      font-size: 14px;
      color: var(--quiet);
    }
  `,
})
export class UndoBar {
  protected readonly reminders = inject(RemindersService);
}
