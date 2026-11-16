import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { LENSES, inLens, lensId, rowOfLenses } from './lenses';
import { NoteList } from './note-list';
import { PageHeader } from '../home/page-header';

/**
 * All notes and search, on its own screen (the phone), through lenses:
 * Recent, Concepts, People, Projects, Tags, Archived (#31), Trash
 * (#217). Each lens
 * is a URL, /browse/<lens>, so back returns to it. The other places
 * are Home's tiles, not a list of links here (#286, 2026-11-15). Since
 * #288 the search box comes first (`/` reaches it), the lenses are one
 * row that scrolls inside itself, and an empty lens is left out.
 */
@Component({
  selector: 'app-browse',
  imports: [PageHeader, RouterLink, NoteList],
  host: { '(document:keydown)': 'slash($event)' },
  template: `
    <main class="page">
      <app-page-header title="Notes" />
      <!-- The search box first, full width, then one row of lenses
           under it (#288, 2026-11-15), put there by the list. -->
      <app-note-list [lens]="lens()">
        <nav #lensRow aria-label="Lenses">
          @for (l of lenses(); track l.id) {
            <a
              class="touch-target"
              [routerLink]="l.id === 'recent' ? '/browse' : ['/browse', l.id]"
              [attr.aria-current]="l.id === lens() ? 'page' : null"
              >{{ l.label }} <span class="count">{{ l.count }}</span></a
            >
          }
        </nav>
        @if (lens() === 'recipes' && modules.kitchen()) {
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
          <label class="new-recipe">
            Import from a link
            <input
              #link
              type="url"
              inputmode="url"
              placeholder="https://"
              enterkeyhint="go"
              [disabled]="!notesReady()"
              (change)="importRecipe(link)"
            />
          </label>
          @if (recipeRefused()) {
            <p class="muted" role="status">{{ recipeRefused() }}</p>
          }
        }
      </app-note-list>
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
    /* One row that scrolls sideways inside itself, never the page
       (#288). Its padding holds the chips' 44 px tap areas and focus
       rings, which the scrolling box would otherwise cut. */
    nav {
      position: relative;
      display: flex;
      flex-wrap: nowrap;
      gap: var(--space-1);
      margin: var(--space-1) 0 var(--space-2);
      padding: 10px 2px;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
    }
    nav::-webkit-scrollbar {
      display: none;
    }
    nav a {
      flex: none;
      white-space: nowrap;
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
  protected readonly modules = inject(ModulesService);
  protected readonly lens = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((p) => lensId(p.get('lens')))),
    { initialValue: lensId(undefined) },
  );
  protected readonly lenses = computed(() => {
    // Trash's count is of the notes in it (#217); every other lens leaves them out.
    const all = [...this.notes.notes(), ...this.notes.trash()];
    // A module that is off takes its lens with it (#126).
    const off = (id: string) =>
      (id === 'projects' && !this.modules.projects()) ||
      (id === 'recipes' && !this.modules.kitchen()) ||
      (id === 'clippings' && !this.modules.reader());
    return rowOfLenses(
      LENSES.filter((l) => !off(l.id)).map((l) => ({
        ...l,
        count: all.filter((n) => inLens(l.id, n)).length,
      })),
      this.lens(),
    );
  });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly lensRow = viewChild<ElementRef<HTMLElement>>('lensRow');

  constructor() {
    // The open lens in sight in its row, as it opens and as the row
    // gains or loses a lens before it (the notes arriving).
    const injector = inject(Injector);
    const row = computed(() =>
      this.lenses()
        .map((l) => l.id)
        .join(),
    );
    effect(() => {
      this.lens();
      row();
      afterNextRender(() => this.showOpenLens(), { injector });
    });
  }

  /** Scrolls the lens row, never the page, so the open lens is in it. */
  private showOpenLens(): void {
    const row = this.lensRow()?.nativeElement;
    const open = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !open) return;
    const left = open.offsetLeft;
    const right = left + open.offsetWidth;
    if (left < row.scrollLeft) row.scrollLeft = left - 8;
    else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 8;
  }

  /**
   * `/` on a keyboard goes to the search box (#288), unless it is being
   * typed somewhere: nothing else on this screen uses the key.
   */
  protected slash(event: KeyboardEvent): void {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    )
      return;
    const search = this.host.nativeElement.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) return;
    event.preventDefault();
    search.focus();
  }

  /** A recipe from a link (#128), opened while the server reads its page. */
  protected importRecipe(input: HTMLInputElement): void {
    const url = input.value.trim();
    if (!url) return;
    if (!this.notes.ready) {
      this.recipeRefused.set('One moment: your notes are still loading. Try again shortly.');
      return;
    }
    const id = this.notes.importRecipe(url);
    if (!id) {
      this.recipeRefused.set('That is not a web link: it starts with https:// or http://.');
      return;
    }
    input.value = '';
    this.recipeRefused.set('');
    void this.router.navigate(['/n', id]);
  }

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
