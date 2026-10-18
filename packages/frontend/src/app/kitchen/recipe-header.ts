import { Component, computed, inject, input } from '@angular/core';
import { hostOf, ingredients, methodSteps } from '@mossgoblin/schema';
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
        <input #name [value]="note().title" (change)="rename(name)" (keydown.enter)="name.blur()" />
      </label>
      <p class="meta">{{ summary() }}</p>
      @if (reading()) {
        <p class="import" role="status">Reading the recipe from {{ site() }}…</p>
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

  protected rename(input: HTMLInputElement): void {
    const title = input.value.trim();
    // A recipe always has a name: a blank one puts the old name back.
    if (!title) {
      input.value = this.note().title;
      return;
    }
    this.notes.updateRecipe(this.note().id, { title });
  }
}
