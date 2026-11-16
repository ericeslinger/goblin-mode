import {
  Component,
  type ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { type RecipeSort, recipeRows } from './kitchen-lines';
import { KitchenTabs } from './kitchen-tabs';

/**
 * Kitchen's Recipes tab (`/kitchen/recipes`, #220): the recipe book.
 * Since #288 (2026-11-15): A to Z, or Made lately, from the meal plans'
 * ticked dinners as a recipe's back counts them (#129); a search that
 * narrows by name as it is typed, on the device; "made 3×, last Nov 2"
 * only on a recipe that was made; and Add recipe, which makes one as
 * Browse's Recipes lens does (`NotesService.createRecipe`: a generated
 * id, written offline, a name already taken refused) and opens it. The
 * Fish of the week placeholder is not in it.
 */
@Component({
  selector: 'app-kitchen-recipes',
  imports: [KitchenTabs, RouterLink],
  template: `
    <main class="page">
      <app-kitchen-tabs active="recipes" heading />
      @if (!modules.kitchen()) {
        <p>
          Recipes are part of Kitchen, which is switched off.
          <a routerLink="/settings" fragment="modules">Switch it on in Settings</a>.
        </p>
      } @else {
        <div class="tools">
          <input
            type="search"
            class="search"
            aria-label="Search recipes"
            placeholder="Search recipes"
            enterkeyhint="search"
            autocomplete="off"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
          @if (!adding()) {
            <button type="button" class="primary" (click)="startAdding()">Add recipe</button>
          }
        </div>
        @if (adding()) {
          <form class="add" (submit)="$event.preventDefault(); add(name)">
            <label>
              Name of the new recipe
              <input
                #name
                name="name"
                autocomplete="off"
                enterkeyhint="done"
                [value]="query().trim()"
              />
            </label>
            <button type="submit" class="primary" [disabled]="!notesReady()">Make it</button>
            <button type="button" (click)="adding.set(false); refused.set('')">Cancel</button>
          </form>
        }
        @if (refused()) {
          <p class="muted" role="status">{{ refused() }}</p>
        }
        <div class="sort" role="group" aria-label="Order">
          <button type="button" [attr.aria-pressed]="sort() === 'name'" (click)="sort.set('name')">
            A to Z
          </button>
          <button type="button" [attr.aria-pressed]="sort() === 'made'" (click)="sort.set('made')">
            Made lately
          </button>
        </div>
        @if (notes.loaded() && !recipes().length) {
          <p class="muted">
            {{
              query().trim() ? 'No recipe is called “' + query().trim() + '”.' : 'No recipes yet.'
            }}
          </p>
        }
        <ul aria-label="Recipes">
          @for (r of recipes(); track r.id) {
            <li>
              <a [routerLink]="['/n', r.id]">
                <span class="title">{{ r.title }}</span>
                @if (r.made) {
                  <!-- A space between, for the link's name; it does not show. -->
                  <span class="muted">{{ ' ' + r.made }}</span>
                }
              </a>
            </li>
          }
        </ul>
      }
    </main>
  `,
  styles: `
    .tools,
    .add {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      margin-top: var(--space-3);
    }
    .add {
      align-items: flex-end;
    }
    .add label {
      display: grid;
      gap: 2px;
      flex: 1 1 12em;
      font-size: 14px;
      color: var(--quiet);
    }
    .search {
      flex: 1 1 10em;
      min-width: 0;
    }
    input {
      font: inherit;
      font-size: 16px;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: var(--space-1) var(--space-2);
      min-height: 36px;
      box-sizing: border-box;
    }
    @media (pointer: coarse) {
      input {
        min-height: 44px;
      }
    }
    .sort {
      display: flex;
      gap: 4px;
      margin-top: var(--space-3);
    }
    .sort button {
      font-size: 14px;
      border-radius: var(--radius-pill);
    }
    .sort button[aria-pressed='true'] {
      font-weight: 600;
      border-color: var(--accent);
      background: var(--chip-bg);
    }
    ul {
      list-style: none;
      margin: var(--space-3) 0 0;
      padding: 0;
      border-top: 1px solid var(--rule);
    }
    li {
      border-bottom: 1px solid var(--rule);
    }
    li a {
      display: grid;
      gap: 2px;
      padding: 12px 4px;
      color: var(--ink);
      text-decoration: none;
    }
    .title {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
  `,
})
export class KitchenRecipes {
  protected readonly modules = inject(ModulesService);
  protected readonly notes = inject(NotesService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  protected readonly query = signal('');
  protected readonly sort = signal<RecipeSort>('name');
  protected readonly adding = signal(false);
  protected readonly refused = signal('');
  /** Names are checked against every note, so Add recipe waits for them, as Browse's does. */
  protected readonly notesReady = computed(() => this.notes.loaded() && this.notes.ready);
  private readonly name = viewChild<ElementRef<HTMLInputElement>>('name');

  protected readonly recipes = computed(() =>
    recipeRows(this.notes.notes(), this.notes.made(), this.query(), this.sort()),
  );

  protected startAdding(): void {
    this.adding.set(true);
    this.refused.set('');
    afterNextRender(() => this.name()?.nativeElement.focus(), { injector: this.injector });
  }

  /** A new recipe, opened to fill in, as Browse's New recipe makes one (#127). */
  protected add(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) return;
    // Names are checked against every note: wait until they are here.
    if (!this.notes.ready) {
      this.refused.set('One moment: your notes are still loading. Try again shortly.');
      return;
    }
    const id = this.notes.createRecipe(name);
    if (!id) {
      this.refused.set(`“${name}” already names a note.`);
      return;
    }
    this.refused.set('');
    this.adding.set(false);
    void this.router.navigate(['/n', id]);
  }
}
