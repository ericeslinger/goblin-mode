import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { ProposalsService } from '../claude/proposals.service';
import { ModulesService } from '../modules/modules.service';
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
      @if (lens() === 'recipes') {
        <!-- Added on change: Enter, or leaving the field, as a phone finishes. -->
        <label class="new-recipe">
          New recipe
          <input
            #recipe
            placeholder="Its name"
            enterkeyhint="done"
            [disabled]="!notesReady()"
            (change)="newRecipe(recipe)"
          />
        </label>
        @if (recipeRefused()) {
          <p class="muted" role="status">{{ recipeRefused() }}</p>
        }
      }
      <app-note-list [lens]="lens()" />
    </main>
  `,
  styles: `
    .new-recipe {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      margin: var(--space-2) 0;
    }
    .new-recipe input {
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: var(--space-1) var(--space-2);
    }
    .muted {
      color: var(--quiet);
    }
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
  private readonly router = inject(Router);
  protected readonly recipeRefused = signal('');
  /** Names are checked against every note, so New recipe waits for them. */
  protected readonly notesReady = computed(() => this.notes.loaded() && this.notes.ready);
  private readonly modules = inject(ModulesService);
  protected readonly proposals = inject(ProposalsService);
  protected readonly reading = inject(ReadingService);
  protected readonly lens = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((p) => lensId(p.get('lens')))),
    { initialValue: lensId(undefined) },
  );
  protected readonly lenses = computed(() => {
    const all = this.notes.notes();
    // A module that is off takes its lens with it (#126).
    const off = (id: string) =>
      (id === 'projects' && !this.modules.projects()) ||
      (id === 'recipes' && !this.modules.kitchen());
    return LENSES.filter((l) => !off(l.id)).map((l) => ({
      ...l,
      count: all.filter((n) => inLens(l.id, n)).length,
    }));
  });

  /** A new recipe (#127), opened to fill in; a name already taken is refused. */
  protected newRecipe(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) return;
    // Names are checked against every note: wait until they are here.
    if (!this.notes.ready) {
      this.recipeRefused.set('One moment: your notes are still loading. Try again shortly.');
      return;
    }
    const id = this.notes.createRecipe(name);
    if (!id) {
      this.recipeRefused.set(`“${name}” already names a note.`);
      return;
    }
    input.value = '';
    this.recipeRefused.set('');
    void this.router.navigate(['/n', id]);
  }
}
