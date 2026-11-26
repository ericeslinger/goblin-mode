import { DOCUMENT } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
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
    } @else {
      <p class="muted">Nothing is shared. Share a copy from the back of a note or a recipe.</p>
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
  protected readonly said = signal('');

  protected link(shareId: string): string {
    return shareLink(this.origin, shareId);
  }

  protected stop(id: string, title: string): void {
    this.notes.stopShare(id);
    this.said.set(`Stopped sharing ${title || 'Untitled'}.`);
  }
}
