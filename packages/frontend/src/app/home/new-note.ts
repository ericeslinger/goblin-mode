import { Component, Injectable, Injector, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CaptureService } from '../capture/capture.service';
import { Icon } from './icon';

/**
 * New note (#272, Eric, 2026-11-15): a fresh, empty note with the cursor
 * in it, from anywhere, as a launch gave until the app began reopening
 * where it was left. The launch screen handles it itself while it shows
 * (its New: the old note keeps its URL in history, the cursor is in the
 * new one before any navigation); anywhere else it is the capture
 * loop's own New and then `/`, whose editor takes the cursor as it
 * opens. Nothing waits on the network or on sign-in.
 */
@Injectable({ providedIn: 'root' })
export class NewNoteService {
  private readonly injector = inject(Injector);
  private handler?: () => Promise<void>;

  /** The screen showing a note starts its own; undone when it goes. */
  handle(start: () => Promise<void>): () => void {
    this.handler = start;
    return () => {
      if (this.handler === start) this.handler = undefined;
    };
  }

  async start(): Promise<void> {
    if (this.handler) return this.handler();
    // Got here, not injected: the screens drawing the button need not
    // make the capture loop just to show it.
    this.injector.get(CaptureService).newNote();
    await this.injector.get(Router).navigateByUrl('/');
  }
}

/**
 * The New note button, just right of the leaf (#272): an icon named
 * "New note", the leaf's size and 44 px target.
 */
@Component({
  selector: 'app-new-note',
  imports: [Icon],
  template: `<button type="button" aria-label="New note" (click)="start()">
    <app-icon name="new-note" />
  </button>`,
  styles: `
    :host {
      display: inline-flex;
      /* The leaf's link reaches 8 px past its box; this starts where it ends. */
      margin-left: var(--space-2);
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-2)) calc(-1 * var(--space-2)) 0;
      padding: 0;
      border: 0;
      border-radius: var(--radius-control);
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
  `,
})
export class NewNoteButton {
  private readonly newNote = inject(NewNoteService);

  protected start(): void {
    void this.newNote.start();
  }
}
