import { Component, computed, inject, input } from '@angular/core';
import { Icon } from '../home/icon';
import { type ItemRecord, ItemsService } from '../reader/items.service';

/**
 * Add to the queue (#249), on an episode's row in Latest and on a
 * show's page: a toggle that reads "In the queue" (pressed) once the
 * episode is in the listening queue, and takes it off again on a
 * second press. Its name names the episode, so each row's is its own.
 */
@Component({
  selector: 'app-queue-button',
  imports: [Icon],
  template: `
    <button
      type="button"
      [attr.aria-pressed]="queued() ? 'true' : 'false'"
      [attr.aria-label]="label()"
      (click)="toggle()"
    >
      <app-icon [name]="queued() ? 'queued' : 'queue-add'" [size]="22" />
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-control);
      background: transparent;
      cursor: pointer;
    }
    button[aria-pressed='true'] {
      background: var(--chip-bg);
    }
  `,
})
export class QueueButton {
  readonly item = input.required<Pick<ItemRecord, 'id' | 'title'>>();
  private readonly items = inject(ItemsService);
  protected readonly queued = computed(() => this.items.queued(this.item().id));
  protected readonly label = computed(() =>
    this.queued()
      ? `${this.item().title} is in the queue`
      : `Add ${this.item().title} to the queue`,
  );

  protected toggle(): void {
    const id = this.item().id;
    if (this.queued()) this.items.removeFromQueue(id);
    else this.items.addToQueue(id);
  }
}
