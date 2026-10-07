import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { matchesSearch } from '@mossgoblin/schema';
import { NotesService, type NoteRecord } from '../notes/notes.service';

/** The text shown under a note's title: its body after the title line. */
export function snippet(note: NoteRecord, length = 90): string {
  const lines = note.body
    .split('\n')
    .map((l) => l.replace(/^[#>\s*+-]+(\[[ xX]\]\s*)?/, '').trim());
  const rest = lines.filter(Boolean).slice(1).join(' ');
  return rest.length > length ? `${rest.slice(0, length - 1)}…` : rest;
}

/** Case-insensitive match on title and body, every word must appear. */
export function matches(note: NoteRecord, search: string): boolean {
  return matchesSearch(note, search);
}

/**
 * All notes, newest first, with a search box. Used by the Browse page on
 * the phone and as the left pane on wide screens.
 */
@Component({
  selector: 'app-note-list',
  imports: [RouterLink],
  template: `
    <label class="search">
      <span class="visually-hidden">Search notes</span>
      <input
        type="search"
        placeholder="Search notes"
        [value]="search()"
        (input)="search.set($any($event.target).value)"
      />
    </label>
    @if (shown().length === 0) {
      <p class="muted">{{ search() ? 'No notes match.' : 'No notes planted yet.' }}</p>
    }
    <ul aria-label="Notes">
      @for (note of shown(); track note.id) {
        <li>
          <a
            [routerLink]="['/n', note.id]"
            [attr.aria-current]="note.id === current() ? 'true' : null"
          >
            <span class="title">{{ note.title || 'Untitled' }}</span>
            @if (snippetOf(note); as text) {
              <span class="snippet">{{ text }}</span>
            }
          </a>
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: block;
    }
    .search input {
      box-sizing: border-box;
      width: 100%;
      font: inherit;
      padding: 10px 12px;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      color: var(--ink);
      background: var(--surface);
    }
    ul {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
    }
    a {
      display: grid;
      gap: 2px;
      padding: 10px 4px;
      border-bottom: 1px solid var(--rule);
      color: var(--ink);
      text-decoration: none;
    }
    a[aria-current='true'] .title {
      color: var(--accent);
    }
    .title {
      font-weight: 600;
    }
    .snippet,
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
  `,
})
export class NoteList {
  private readonly notes = inject(NotesService);
  /** The open note, highlighted in the list. */
  readonly current = input<string | undefined>(undefined);
  protected readonly search = signal('');
  protected readonly shown = computed(() =>
    this.notes.notes().filter((n) => !n.archived && n.body.trim() && matches(n, this.search())),
  );
  protected readonly snippetOf = (note: NoteRecord) => snippet(note);
}
