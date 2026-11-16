import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { plainText } from '@mossgoblin/editor/grammar';
import { TRASH_DAYS, matchesSearch, moodsOf } from '@mossgoblin/schema';
import { STATUSES, kindLabel, statusLabel } from '../links/project-labels';
import { LinksService } from '../links/links.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { RemindersService } from '../reminders/reminders.service';
import { type LensId, byTag, goneIn, inLens, projectTree } from './lenses';

/**
 * The text shown under a note's title: the plain words of its body after
 * the title line (#285, 2026-11-15), shown only, never stored. Only the
 * first lines are parsed, each to a limit, so a long or mark-heavy note
 * costs no more than a short one.
 */
export function snippet(note: NoteRecord, length = 90): string {
  // The list redraws as notes change: each note's body is read once per
  // change, and one entry is kept per note, not per body it ever had.
  const known = snippets.get(note.id);
  if (known && known.body === note.body && known.length === length) return known.text;
  if (!known && snippets.size >= SNIPPETS_KEPT) snippets.clear();
  const text = readSnippet(note.body, length);
  snippets.set(note.id, { body: note.body, length, text });
  return text;
}

const SNIPPETS_KEPT = 5000;
const snippets = new Map<string, { body: string; length: number; text: string }>();

/** The most of one line that is read: enough for any address in a link. */
const LINE_READ = 2000;
/** The most that is read in all when the first lines held no words. */
const FURTHER = 6000;

function readSnippet(body: string, length: number): string {
  const lines = body.split('\n');
  const title = lines.findIndex((l) => l.trim());
  if (title < 0) return '';
  // Whole lines, so no link is cut before it is read, each to a limit,
  // so one long mark-heavy line costs no more than a short one.
  const take = (from: number, most: number): { text: string; next: number } => {
    const taken: string[] = [];
    let size = 0;
    let at = from;
    while (at < lines.length && size <= most) {
      const line = cutLine(lines[at++]!);
      taken.push(line);
      size += line.length;
    }
    return { text: words(taken.join('\n')), next: at };
  };
  const first = take(title + 1, length * 4);
  // Lines that were all markup (an image with no alt) gave no words: read on.
  const rest = first.text || take(first.next, FURTHER).text;
  return rest.length > length ? `${rest.slice(0, length - 1)}…` : rest;
}

/**
 * A line to at most LINE_READ characters. A cut that lands inside an
 * image or link (a pasted `data:` address) drops it from its opening
 * mark, so the address never shows as words.
 */
function cutLine(line: string): string {
  if (line.length <= LINE_READ) return line;
  const cut = line.slice(0, LINE_READ);
  const open = cut.lastIndexOf('](');
  if (open < 0 || cut.indexOf(')', open) >= 0) return cut;
  const start = cut.lastIndexOf('[', open);
  if (start < 0) return cut.slice(0, open);
  return cut.slice(0, start > 0 && cut[start - 1] === '!' ? start - 1 : start);
}

function words(text: string): string {
  return plainText(text).replace(/\s+/g, ' ').trim();
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
    <!-- What the screen puts under the search box: Browse's lenses (#288). -->
    <ng-content />
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
    } @else if (lens() === 'trash') {
      <!-- Not links: a note in Trash opens nowhere until it is restored (#217). -->
      <ul aria-label="Notes">
        @for (note of shown(); track note.id) {
          <li class="trashed">
            <span class="row">
              <span class="title">{{ note.title || 'Untitled' }}</span>
              <span class="snippet">{{ gone(note) }}</span>
            </span>
            <!-- The label starts with the words shown (WCAG 2.5.3). -->
            <button
              type="button"
              [attr.aria-label]="'Restore: ' + (note.title || 'Untitled')"
              (click)="notes.setDeleted(note.id, false)"
            >
              Restore
            </button>
          </li>
        }
      </ul>
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
        @if (projectLine(note); as parts) {
          <!-- One line that reads as words: "Build · Active · 2 open tasks". -->
          <span class="meta">
            @for (p of parts; track p.text; let first = $first) {
              @if (!first) {
                <span class="sep"> · </span>
              }
              <span [class.chip]="p.chip">{{ p.text }}</span>
            }
          </span>
        }
      </a>
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
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
    /* One column that never grows past the list: a long address in a
       title or snippet wraps instead of widening the page (#285). */
    a {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
      padding: 10px 4px;
      border-bottom: 1px solid var(--rule);
      color: var(--ink);
      text-decoration: none;
    }
    .trashed {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--rule);
    }
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      min-width: 0;
      gap: 2px;
      padding: 10px 4px;
    }
    .trashed button {
      font: inherit;
      font-size: 14px;
      padding: 2px 12px;
      border-radius: var(--radius-pill);
      border: var(--border) solid var(--rule);
      color: var(--ink);
      background: var(--surface);
      cursor: pointer;
    }
    a[aria-current='true'] .title {
      color: var(--accent);
    }
    .title {
      font-weight: 600;
    }
    .title,
    .snippet {
      min-width: 0;
      overflow-wrap: anywhere;
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
    /* A project's status as a chip and its open tasks (#288). */
    .meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      font-size: 13px;
      color: var(--quiet);
    }
    .chip {
      padding: 1px var(--space-2);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-pill);
      color: var(--ink);
      background: var(--chip-bg);
    }
    .tag {
      font-size: 14px;
      color: var(--quiet);
      margin: var(--space-3) 0 0;
    }
  `,
})
export class NoteList {
  protected readonly notes = inject(NotesService);
  private readonly now = inject(NOW);
  private readonly links = inject(LinksService);
  private readonly reminders = inject(RemindersService);
  /** The open note, highlighted in the list. */
  readonly current = input<string | undefined>(undefined);
  /** Which notes to list (Browse lenses, #31). */
  readonly lens = input<LensId>('recent');
  protected readonly search = signal('');
  /** Projects lens: one status, or '' for all (#41). */
  protected readonly statusFilter = signal('');
  protected readonly statuses = STATUSES;
  protected readonly shown = computed(() =>
    // Trash lists the notes deleted, the last deleted first (#217).
    (this.lens() === 'trash' ? this.notes.trash() : this.notes.notes()).filter(
      (n) =>
        inLens(this.lens(), n) &&
        matches(n, this.search()) &&
        (this.lens() !== 'projects' ||
          !this.statusFilter() ||
          n.projectStatus === this.statusFilter()),
    ),
  );
  protected readonly tree = computed(() => projectTree(this.shown()));
  /**
   * Each note's open tasks, as its project header counts them: the
   * reminders linked to it that are not done (#288). Already on the
   * device for Right Now; no query of its own.
   */
  protected readonly openTasks = computed(() => {
    const open = new Map<string, number>();
    for (const r of this.reminders.reminders()) {
      if (r.noteId && r.status !== 'done') open.set(r.noteId, (open.get(r.noteId) ?? 0) + 1);
    }
    return open;
  });
  protected readonly tagged = computed(() => byTag(this.shown()));
  protected readonly empty: Record<LensId, string> = {
    recent: 'No notes planted yet.',
    concepts: 'No concepts yet. Link a name with [[ to make one.',
    people: 'No people yet. Set a concept’s type to Person.',
    projects: 'No projects yet. Set a concept’s type to Project.',
    recipes: 'No recipes yet. Name one above to start it.',
    clippings: 'No clippings yet. File an article from the Reader.',
    journal: 'No journal entries yet. Add a feelings journal in Settings.',
    tags: 'No tagged notes yet.',
    archived: 'Nothing archived.',
    trash: `Nothing in Trash. A deleted note stays here for ${TRASH_DAYS} days.`,
  };

  /** "Gone in 12 days" (#217), by this device's clock. */
  protected gone(note: NoteRecord): string {
    return goneIn(note, this.now());
  }

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

  /**
   * A project's line in the Projects lens (#288): its kind, its status
   * as a chip and its open tasks, each a part with " · " between, so it
   * reads (and copies) as words; undefined when it has none of them.
   */
  protected projectLine(note: NoteRecord): { text: string; chip: boolean }[] | undefined {
    if (this.lens() !== 'projects' || note.conceptType !== 'project') return undefined;
    const kind = kindLabel(note.projectKind);
    const status = statusLabel(note.projectStatus);
    const open = this.openTasks().get(note.id) ?? 0;
    const parts = [
      ...(kind ? [{ text: kind, chip: false }] : []),
      ...(status ? [{ text: status, chip: true }] : []),
      ...(open ? [{ text: `${open} open ${open === 1 ? 'task' : 'tasks'}`, chip: false }] : []),
    ];
    return parts.length ? parts : undefined;
  }

  /**
   * A concept says how many notes link to it; a note shows its text. A
   * project says its kind and status ("Build · Active"); in the
   * Projects lens that line is `projectLine` instead (#288).
   */
  protected snippetOf(note: NoteRecord): string {
    if (this.lens() === 'journal') return this.journalLine(note);
    if (note.kind !== 'concept') return snippet(note);
    if (note.conceptType === 'project') {
      if (this.projectLine(note)) return '';
      const meta = [kindLabel(note.projectKind), statusLabel(note.projectStatus)];
      if (meta.some(Boolean)) return meta.filter(Boolean).join(' · ');
    }
    const n = this.links.backlinkCounts().get(note.id) ?? 0;
    const linked = n === 1 ? 'Linked from 1 note' : `Linked from ${n} notes`;
    return note.body.trim() ? `${linked} · ${snippet(note)}` : linked;
  }
}
