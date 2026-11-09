import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { SET_ASIDE_HEADING, hostOf, ingredients, methodSteps } from '@mossgoblin/schema';
import { NotesService, type NoteRecord } from '../notes/notes.service';

/**
 * Above a recipe's text (#127): its name, Eric's own, and a line saying
 * what the text holds; while an import reads its page, or after one
 * failed, a line saying so (#128). Servings and the source are on the
 * back (#112).
 */
@Component({
  selector: 'app-recipe-header',
  template: `
    <section class="recipe" aria-label="Recipe">
      <label class="name">
        <span class="visually-hidden">Recipe name</span>
        <!--
          Kept on the device as typed, and written on leaving the field or
          the page (#205), never after a pause, as the concept name is. Its
          value is set by the class, never over typing.
        -->
        <input
          #name
          (input)="typeName(name.value)"
          (change)="leaveName(name)"
          (keydown.enter)="name.blur()"
        />
      </label>
      <p class="meta">{{ summary() }}</p>
      @if (reading()) {
        <p class="import" role="status">Reading the recipe from {{ site() }}…</p>
      } @else if (setAside()) {
        <p class="import" role="status">
          Some lines on {{ site() }} did not read as a recipe and were left out; they are on the
          back, under the original text.
        </p>
      } @else if (note().importState === 'failed') {
        <p class="import" role="status">
          Could not import from {{ site() }}: {{ note().importError || 'no reason given' }}.
          <button type="button" (click)="notes.retryImport(note().id)">Try again</button>
        </p>
      }
    </section>
  `,
  styles: `
    .recipe {
      padding: var(--space-2) var(--space-3) 0;
      border-bottom: 1px solid var(--rule);
    }
    .name input {
      width: 100%;
      box-sizing: border-box;
      font: inherit;
      font-family: var(--font-heading);
      font-size: 1.4em;
      font-weight: 600;
      color: var(--ink);
      background: transparent;
      border: 0;
      padding: var(--space-1) 0;
    }
    .import {
      margin: 0 0 var(--space-2);
      font-size: 14px;
      color: var(--quiet);
    }
    .import button {
      font: inherit;
      color: var(--accent);
      background: none;
      border: 0;
      padding: 0;
      text-decoration: underline;
      cursor: pointer;
    }
    .meta {
      margin: 0;
      padding-bottom: var(--space-2);
      font-size: 14px;
      color: var(--quiet);
    }
  `,
})
export class RecipeHeader {
  readonly note = input.required<NoteRecord>();
  protected readonly notes = inject(NotesService);
  protected readonly reading = computed(
    () => this.note().importState === 'requested' || this.note().importState === 'working',
  );
  /** An import left lines out as not a recipe's (Eric, 2026-10-18). */
  protected readonly setAside = computed(
    () =>
      this.note().importState === 'done' && !!this.note().source?.text?.includes(SET_ASIDE_HEADING),
  );
  /** The site an import reads, for saying so (#128). */
  protected readonly site = computed(() => hostOf(this.note().source?.url ?? '') || 'the link');

  /** "Recipe · serves 4 · 6 ingredients · 5 steps", from the text. */
  protected readonly summary = computed(() => {
    const note = this.note();
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    return [
      'Recipe',
      note.servings ? `serves ${note.servings}` : '',
      count(ingredients(note.body).length, 'ingredient'),
      count(methodSteps(note.body).length, 'step'),
    ]
      .filter(Boolean)
      .join(' · ');
  });

  private readonly nameBox = viewChild<ElementRef<HTMLInputElement>>('name');
  /** A name typed and kept on the device, not yet written. */
  private typed?: { id: string; name: string };
  /** Which recipe's name the field shows. */
  private shown?: string;

  constructor() {
    // The field shows the stored name, except while it has focus: a
    // snapshot of an earlier write must never land on later typing.
    const doc = inject(DOCUMENT);
    effect(() => {
      const box = this.nameBox()?.nativeElement;
      const { id, title } = this.note();
      if (!box || (box === doc.activeElement && this.shown === id)) return;
      box.value = title;
      this.shown = id;
    });
    // A page closed with the field focused never fires change (#205).
    const onPageHide = () => this.writeName();
    doc.defaultView?.addEventListener('pagehide', onPageHide);
    inject(DestroyRef).onDestroy(() => {
      doc.defaultView?.removeEventListener('pagehide', onPageHide);
      this.writeName();
    });
  }

  /**
   * Every keystroke in the name: kept on the device at once, so a page
   * closed now keeps it, and written on leaving. Not after a pause: meal
   * plan slots link to a recipe by its title, and a half-typed one would
   * break them, show in lists, and can read as taken. A blank name keeps
   * nothing.
   */
  protected typeName(value: string): void {
    const id = this.note().id;
    // Typed into another recipe's field: that one is written first.
    if (this.typed && this.typed.id !== id) this.writeName();
    this.typed = this.notes.holdName(id, value) ? { id, name: value } : undefined;
  }

  /** Writes the name waiting, now. */
  private writeName(): void {
    const typed = this.typed;
    if (!typed) return;
    this.typed = undefined;
    this.notes.rename(typed.id, typed.name);
  }

  /** Leaving the field (change): what waits is written now. */
  protected leaveName(input: HTMLInputElement): void {
    // A recipe always has a name: a blank one puts the old name back.
    if (!input.value.trim()) {
      this.typeName('');
      input.value = this.note().title;
      return;
    }
    if (!this.typed && input.value.trim() === this.note().title) return;
    this.typeName(input.value);
    this.writeName();
  }
}
