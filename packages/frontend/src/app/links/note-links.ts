import { Component, computed, inject, input } from '@angular/core';
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
  `,
  styles: `
    :host {
      display: block;
      padding: 0 var(--space-3);
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
}
