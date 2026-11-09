import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FISH_ID, madeLine, normalizeName } from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { KitchenTabs } from './kitchen-tabs';

/**
 * Kitchen's Recipes tab (`/kitchen/recipes`, #220): the recipe book,
 * every recipe newest first, each with how often it was made and when
 * last, from the meal plans' ticked dinners, as its back says (#129).
 * The Fish of the week placeholder is not in it.
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
        @if (notes.loaded() && !recipes().length) {
          <p class="muted">No recipes yet.</p>
        }
        <ul aria-label="Recipes">
          @for (r of recipes(); track r.id) {
            <li>
              <a [routerLink]="['/n', r.id]">
                <span class="title">{{ r.title }}</span>
                <!-- A space between, for the link's name; it does not show. -->
                <span class="muted">{{ ' ' + r.made }}</span>
              </a>
            </li>
          }
        </ul>
        <p class="more"><a routerLink="/browse/recipes">New recipe</a>, in Browse, Recipes.</p>
      }
    </main>
  `,
  styles: `
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
    .more {
      font-size: 14px;
      color: var(--quiet);
    }
  `,
})
export class KitchenRecipes {
  protected readonly modules = inject(ModulesService);
  protected readonly notes = inject(NotesService);

  /**
   * Newest first; one not yet on the server has no time yet, so it is
   * newest. Fish of the week is left out by its id, not its name: it is
   * the placeholder a new week's fish dinner links to, not a dish, and
   * it stays out even once renamed or filled in.
   */
  protected readonly recipes = computed(() => {
    const made = this.notes.made();
    return this.notes
      .notes()
      .filter((n) => n.kind === 'recipe' && !n.archived && n.id !== FISH_ID)
      .sort((a, b) => (b.createdAt ?? Infinity) - (a.createdAt ?? Infinity))
      .map((n) => ({
        id: n.id,
        title: n.title,
        made: madeLine(made.get(normalizeName(n.title))) || 'Not made yet',
      }));
  });
}
