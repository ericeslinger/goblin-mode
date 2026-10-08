import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { matchesSearch, moodsOf } from '@mossgoblin/schema';
import { STATUSES, kindLabel, statusLabel } from '../links/project-labels';
import { LinksService } from '../links/links.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { type LensId, byTag, inLens, projectTree } from './lenses';

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
    @if (lens() === 'projects') {
      <label class="status">
        Status
        <select #status (change)="statusFilter.set(status.value)">
          <option value="">All</option>
          @for (s of statuses; track s.id) {
            <option [value]="s.id" [selected]="s.id === statusFilter()">{{ s.label }}</option>
          }
        </select>
      </label>
    }
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
    } @else if (lens() === 'projects') {
      <ul aria-label="Projects">
        @for (p of tree(); track p.note.id) {
          <li [style.padding-left.px]="p.depth * 20">
            <ng-container *ngTemplateOutlet="row; context: { $implicit: p.note }" />
          </li>
        }
      </ul>
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
    .status {
      display: block;
      margin-top: var(--space-2);
      font-size: 14px;
      color: var(--quiet);
    }
    .status select {
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: var(--space-1) var(--space-2);
      margin-left: var(--space-1);
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
  /** Projects lens: one status, or '' for all (#41). */
  protected readonly statusFilter = signal('');
  protected readonly statuses = STATUSES;
  protected readonly shown = computed(() =>
    this.notes
      .notes()
      .filter(
        (n) =>
          inLens(this.lens(), n) &&
          matches(n, this.search()) &&
          (this.lens() !== 'projects' ||
            !this.statusFilter() ||
            n.projectStatus === this.statusFilter()),
      ),
  );
  protected readonly tree = computed(() => projectTree(this.shown()));
  protected readonly tagged = computed(() => byTag(this.shown()));
  protected readonly empty: Record<LensId, string> = {
    recent: 'No notes planted yet.',
    concepts: 'No concepts yet. Link a name with [[ to make one.',
    people: 'No people yet. Set a concept’s type to Person.',
    projects: 'No projects yet. Set a concept’s type to Project.',
    journal: 'No journal entries yet. Add a feelings journal in Settings.',
    tags: 'No tagged notes yet.',
    archived: 'Nothing archived.',
  };

  /** A journal entry: when, and its moods (#40). */
  private journalLine(note: NoteRecord): string {
    const when = note.createdAt
      ? new Date(note.createdAt).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : '';
    return [when, moodsOf(note.body).join(', ')].filter(Boolean).join(' · ');
  }

  /** A concept says how many notes link to it; a note shows its text. */
  protected snippetOf(note: NoteRecord): string {
    if (this.lens() === 'journal') return this.journalLine(note);
    if (note.kind !== 'concept') return snippet(note);
    if (note.conceptType === 'project') {
      const meta = [kindLabel(note.projectKind), statusLabel(note.projectStatus)];
      if (meta.some(Boolean)) return meta.filter(Boolean).join(' · ');
    }
    const n = this.links.backlinkCounts().get(note.id) ?? 0;
    const linked = n === 1 ? 'Linked from 1 note' : `Linked from ${n} notes`;
    return note.body.trim() ? `${linked} · ${snippet(note)}` : linked;
  }
}
