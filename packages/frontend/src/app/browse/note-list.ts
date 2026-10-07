import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { matchesSearch } from '@mossgoblin/schema';
import { LinksService } from '../links/links.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { type LensId, byTag, inLens } from './lenses';

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
  imports: [RouterLink, NgTemplateOutlet],
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
      <p class="muted">{{ search() ? 'No notes match.' : empty[lens()] }}</p>
    }
    @if (lens() === 'tags') {
      @for (group of tagged(); track group.tag; let i = $index) {
        <!-- Ids from the position: a tag may hold spaces. -->
        <h2 class="tag" [id]="'tag-' + i">#{{ group.tag }} ({{ group.notes.length }})</h2>
        <ul [attr.aria-labelledby]="'tag-' + i">
          @for (note of group.notes; track note.id) {
            <li>
              <ng-container *ngTemplateOutlet="row; context: { $implicit: note }" />
            </li>
          }
        </ul>
      }
    } @else {
      <ul aria-label="Notes">
        @for (note of shown(); track note.id) {
          <li>
            <ng-container *ngTemplateOutlet="row; context: { $implicit: note }" />
          </li>
        }
      </ul>
    }
    <ng-template #row let-note>
      <a [routerLink]="['/n', note.id]" [attr.aria-current]="note.id === current() ? 'true' : null">
        <span class="title">{{ note.title || 'Untitled' }}</span>
        @if (snippetOf(note); as text) {
          <span class="snippet">{{ text }}</span>
        }
      </a>
    </ng-template>
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
    .tag {
      font-size: 14px;
      color: var(--quiet);
      margin: var(--space-3) 0 0;
    }
  `,
})
export class NoteList {
  private readonly notes = inject(NotesService);
  private readonly links = inject(LinksService);
  /** The open note, highlighted in the list. */
  readonly current = input<string | undefined>(undefined);
  /** Which notes to list (Browse lenses, #31). */
  readonly lens = input<LensId>('recent');
  protected readonly search = signal('');
  protected readonly shown = computed(() =>
    this.notes.notes().filter((n) => inLens(this.lens(), n) && matches(n, this.search())),
  );
  protected readonly tagged = computed(() => byTag(this.shown()));
  protected readonly empty: Record<LensId, string> = {
    recent: 'No notes planted yet.',
    concepts: 'No concepts yet. Link a name with [[ to make one.',
    people: 'No people yet. Set a concept’s type to Person.',
    projects: 'No projects yet. Set a concept’s type to Project.',
    tags: 'No tagged notes yet.',
    archived: 'Nothing archived.',
  };

  /** A concept says how many notes link to it; a note shows its text. */
  protected snippetOf(note: NoteRecord): string {
    if (note.kind !== 'concept') return snippet(note);
    const n = this.links.backlinkCounts().get(note.id) ?? 0;
    const linked = n === 1 ? 'Linked from 1 note' : `Linked from ${n} notes`;
    return note.body.trim() ? `${linked} · ${snippet(note)}` : linked;
  }
}
