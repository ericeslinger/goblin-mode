import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LinksService } from './links.service';

/**
 * On the back of a note (#112): the notes that link to it, each with the sentence it
 * does it in, and for a concept the concepts often linked alongside it
 * (#30). Every entry is a link to /n/<id>, so back returns here. Its
 * headings are h3s, under the back's h2, its note's title, as the
 * back's other parts are (2026-11-16, #289; until then h2s).
 */
@Component({
  selector: 'app-note-links',
  imports: [RouterLink],
  template: `
    @if (linkedFrom().length > 0) {
      <section aria-labelledby="linked-from">
        <h3 id="linked-from">Linked from</h3>
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
    } @else if (empty()) {
      <h3>Linked from</h3>
      <p class="sentence">{{ empty() }}</p>
    }
    @if (concept() && together().length > 0) {
      <section aria-labelledby="often-together">
        <h3 id="often-together">Often together</h3>
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
    h3 {
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
  /** Said when nothing links here; nothing is shown without it. */
  readonly empty = input('');
  protected readonly linkedFrom = computed(() => this.links.backlinksTo(this.noteId()));
  protected readonly together = computed(() => this.links.togetherWith(this.noteId()));
}
