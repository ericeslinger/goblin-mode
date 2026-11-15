import { Component, Injectable, inject, signal } from '@angular/core';

/**
 * A write refused for want of the note key (the gardener's switch,
 * 2026-11-15): sealing is on, this device has no key yet, and the write
 * would have had to carry note text, so it was not done and not kept.
 * NotesService says so here; the line below shows it on whatever page
 * the gardener acted on. Words typed, renames and Instructions for
 * Claude are kept and written later, so they say nothing here.
 */
@Injectable({ providedIn: 'root' })
export class KeyWaitNotice {
  private readonly shown = signal(false);
  readonly refused = this.shown.asReadonly();

  say(): void {
    this.shown.set(true);
  }

  clear(): void {
    this.shown.set(false);
  }
}

/** The calm line for a refused write, with a way to put it away. */
@Component({
  selector: 'app-key-wait-line',
  template: `
    @if (notice.refused()) {
      <p class="key-wait" role="status">
        <span>
          That was not done: this device is waiting for its note key, and needs a connection once to
          get it. Try again then.
        </span>
        <button type="button" (click)="notice.clear()">OK</button>
      </p>
    }
  `,
  styles: `
    .key-wait {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin: 0;
      padding: var(--space-2) var(--space-3);
      background: var(--bg);
      color: var(--ink);
      border-bottom: var(--border) solid var(--rule);
    }
  `,
})
export class KeyWaitLine {
  protected readonly notice = inject(KeyWaitNotice);
}
