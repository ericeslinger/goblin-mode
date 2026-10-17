import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LinksService } from './links.service';

/**
 * Under a note: the notes that link to it, each with the sentence it
 * does it in, and for a concept the concepts often linked alongside it
 * (#30). Every entry is a link to /n/<id>, so back returns here.
 */
@Component({
  selector: 'app-note-links',
  imports: [RouterLink],
  template: `
    @if (count() > 0) {
      <!-- Folded, so the note keeps the room (Eric, 2026-10-17); open, it
           lists the notes linking here and, for a concept, the concepts
           often linked alongside it. -->
      <button
        type="button"
        class="fold"
        aria-controls="note-links"
        [attr.aria-expanded]="open()"
        (click)="open.set(!open())"
      >
        Linked from {{ linkedFrom().length }}
      </button>
    }
    @if (open() && count() > 0) {
      <div id="note-links">
        @if (linkedFrom().length > 0) {
          <section aria-labelledby="linked-from">
            <h2 id="linked-from">Linked from</h2>
            <ul>
              @for (b of linkedFrom(); track b.id) {
                <li>
                  <a [routerLink]="['/n', b.id]">{{ b.title }}</a>
                  @if (b.sentence) {
                    <span class="sentence">{{ b.sentence }}</span>
                  }
                </li>
              }
            </ul>
          </section>
        }
        @if (concept() && together().length > 0) {
          <section aria-labelledby="often-together">
            <h2 id="often-together">Often together</h2>
            <ul class="chips">
              @for (c of together(); track c.id) {
                <li>
                  <a [routerLink]="['/n', c.id]">{{ c.title }}</a>
                </li>
              }
            </ul>
          </section>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      padding: 0 var(--space-3);
    }
    .fold {
      font: inherit;
      font-size: 13px;
      color: var(--quiet);
      background: none;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-pill);
      padding: 2px 10px;
      min-height: 24px;
      margin: var(--space-1) 0;
      cursor: pointer;
    }
    .fold[aria-expanded='true'] {
      color: var(--ink);
      background: var(--chip-bg);
    }
    h2 {
      font-size: 14px;
      margin: var(--space-3) 0 var(--space-1);
      color: var(--quiet);
      font-weight: 600;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: grid;
      gap: 2px;
      padding: var(--space-1) 0;
    }
    a {
      color: var(--accent);
    }
    .sentence {
      font-size: 14px;
      color: var(--quiet);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
    }
    .chips li {
      padding: 2px var(--space-2);
      border-radius: var(--radius-pill);
      background: var(--chip-bg);
    }
  `,
})
export class NoteLinks {
  private readonly links = inject(LinksService);
  readonly noteId = input.required<string>();
  readonly concept = input(false);
  protected readonly linkedFrom = computed(() => this.links.backlinksTo(this.noteId()));
  protected readonly together = computed(() => this.links.togetherWith(this.noteId()));
  protected readonly count = computed(
    () => this.linkedFrom().length + (this.concept() ? this.together().length : 0),
  );
  protected readonly open = signal(false);

  constructor() {
    // Folded again for each note opened.
    effect(() => {
      this.noteId();
      this.open.set(false);
    });
  }
}
