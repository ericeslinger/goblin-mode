import { DOCUMENT } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NotesService } from '../notes/notes.service';
import { shareLink } from './share-controls';

/**
 * Settings, Shared links (2026-11-26, Eric): every note shared now, with
 * its link and Stop sharing, so what is public can always be seen. Read
 * from the notes' own `shareId`, never by listing the shares, which no
 * one may do.
 */
@Component({
  selector: 'app-shared-links',
  imports: [RouterLink],
  template: `
    <p>
      Each note here has a public copy of its title and text. Anyone with its link can read the
      copy; it is not listed anywhere, and nothing leads from one to another. Stop sharing and the
      link answers nothing.
    </p>
    @if (notes.shared().length) {
      <ul class="shared" aria-label="Shared notes">
        @for (n of notes.shared(); track n.id) {
          <li>
            <a class="title" [routerLink]="['/n', n.id]">{{ n.title || 'Untitled' }}</a>
            <span class="link">{{ link(n.shareId!) }}</span>
            @if (refusedStop(n.shareId!)) {
              <span class="refused" role="status"
                >Stopping did not reach the server: this copy is still public.</span
              >
            }
            <button
              type="button"
              [attr.aria-label]="'Stop sharing ' + (n.title || 'Untitled')"
              (click)="stop(n.id, n.title)"
            >
              Stop sharing
            </button>
          </li>
        }
      </ul>
    } @else if (!stopping().length) {
      <p class="muted">Nothing is shared. Share a copy from the back of a note or a recipe.</p>
    }
    @if (stopping().length) {
      <h2 id="still-public">Still public</h2>
      <p>
        Sharing is stopped on this device for these, but each copy stays public until this device is
        back online and the stop reaches the server.
      </p>
      <ul class="shared" aria-labelledby="still-public">
        @for (s of stopping(); track s.id) {
          <li>
            <span class="title">{{ s.title || 'Untitled' }}</span>
            <span class="link">{{ link(s.id) }}</span>
          </li>
        }
      </ul>
    }
    @if (said()) {
      <p role="status">{{ said() }}</p>
    }
  `,
  styles: `
    .shared {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .shared li {
      display: grid;
      gap: 2px;
      padding: var(--space-2) 0;
      border-bottom: var(--border) solid var(--rule);
      justify-items: start;
    }
    .title {
      color: var(--accent);
      font-weight: 600;
    }
    .link {
      color: var(--quiet);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .refused {
      font-size: 14px;
      font-weight: 600;
    }
    .muted {
      color: var(--quiet);
    }
    button {
      font: inherit;
      font-size: 14px;
      min-height: 36px;
      padding: 2px 12px;
      margin-top: var(--space-1);
      border-radius: var(--radius-pill);
      border: var(--border) solid var(--rule);
      color: var(--ink);
      background: var(--surface);
      cursor: pointer;
    }
  `,
})
export class SharedLinks {
  protected readonly notes = inject(NotesService);
  private readonly origin = inject(DOCUMENT).defaultView?.location.origin ?? '';
  /** The last note stopped here. */
  private readonly stopped = signal<{ noteId: string; title: string } | undefined>(undefined);
  /**
   * Said as stopped only once the server has the stop; until then the
   * copy is listed under Still public.
   */
  protected readonly said = computed(() => {
    const s = this.stopped();
    if (!s) return '';
    const left = Object.values(this.notes.sharesWaiting()).some(
      (w) => w.op === 'stop' && w.noteId === s.noteId,
    );
    return left ? '' : `Stopped sharing ${s.title || 'Untitled'}.`;
  });
  /** Stops this device made that the server does not have yet: those copies are still public. */
  protected readonly stopping = computed(() =>
    Object.entries(this.notes.sharesWaiting())
      .filter(([, w]) => w.op === 'stop' && !w.failed)
      .map(([id, w]) => ({ id, title: w.title })),
  );

  /** Whether this device's stop of `shareId` was refused by the server. */
  protected refusedStop(shareId: string): boolean {
    const w = this.notes.sharesWaiting()[shareId];
    return !!w?.failed && w.op === 'stop';
  }

  protected link(shareId: string): string {
    return shareLink(this.origin, shareId);
  }

  protected stop(id: string, title: string): void {
    this.notes.stopShare(id);
    this.stopped.set({ noteId: id, title });
  }
}
