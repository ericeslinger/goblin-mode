import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { ProposalsService } from '../claude/proposals.service';
import { NotesService } from '../notes/notes.service';
import { ReadingService } from '../reading/reading.service';
import { LENSES, inLens, lensId } from './lenses';
import { NoteList } from './note-list';

/**
 * All notes and search, on its own screen (the phone), through lenses:
 * Recent, Concepts, People, Projects, Tags, Archived (#31). Each lens
 * is a URL, /browse/<lens>, so back returns to it.
 */
@Component({
  selector: 'app-browse',
  imports: [RouterLink, NoteList],
  template: `
    <main class="page">
      <a routerLink="/">Back</a>
      <h1>Notes</h1>
      <p class="more">
        <a routerLink="/map">See the whole garden as a map</a>
        <a routerLink="/reading"
          >Reading queue
          @if (reading.unread().length) {
            <span class="count">{{ reading.unread().length }} to read</span>
          }
        </a>
        <a routerLink="/activity"
          >What Claude changed
          @if (proposals.open()) {
            <span class="count"
              >{{ proposals.open() }}
              {{ proposals.open() === 1 ? 'suggestion' : 'suggestions' }}</span
            >
          }
        </a>
      </p>
      <nav aria-label="Lenses">
        @for (l of lenses(); track l.id) {
          <a
            [routerLink]="l.id === 'recent' ? '/browse' : ['/browse', l.id]"
            [attr.aria-current]="l.id === lens() ? 'page' : null"
            >{{ l.label }} <span class="count">{{ l.count }}</span></a
          >
        }
      </nav>
      <app-note-list [lens]="lens()" />
    </main>
  `,
  styles: `
    .more {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-3);
    }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      margin: 0 0 var(--space-3);
    }
    nav a {
      padding: var(--space-1) var(--space-2);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-pill);
      color: var(--ink);
      text-decoration: none;
      font-size: 14px;
    }
    nav a[aria-current='page'] {
      border-color: var(--accent);
      background: var(--chip-bg);
    }
    .count {
      color: var(--quiet);
    }
  `,
})
export class Browse {
  private readonly notes = inject(NotesService);
  protected readonly proposals = inject(ProposalsService);
  protected readonly reading = inject(ReadingService);
  protected readonly lens = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((p) => lensId(p.get('lens')))),
    { initialValue: lensId(undefined) },
  );
  protected readonly lenses = computed(() => {
    const all = this.notes.notes();
    return LENSES.map((l) => ({ ...l, count: all.filter((n) => inLens(l.id, n)).length }));
  });
}
