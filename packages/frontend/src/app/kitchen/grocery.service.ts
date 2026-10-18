import { Injectable, computed, inject } from '@angular/core';
import {
  type PlannedDinner,
  SHOPPING_LIST_NAME,
  type Slot,
  listSections,
  mealLabel,
  normalizeName,
  replanGrocery,
} from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { TemplatesService } from '../templates/templates.service';

/**
 * The grocery list the meal plan feeds (#130): the note Kitchen's
 * settings name, else the living note of the Shopping list template.
 * Planning a dinner adds its ingredients there; changing or clearing it
 * takes the old dinner's untouched lines off. Written through the
 * persistent cache like any note, so it works offline.
 */
@Injectable({ providedIn: 'root' })
export class GroceryService {
  private readonly notes = inject(NotesService);
  private readonly modules = inject(ModulesService);
  private readonly templates = inject(TemplatesService);

  /** The template the list is made from, if there is one. */
  private readonly template = computed(() =>
    this.templates.templates().find((t) => t.title === SHOPPING_LIST_NAME),
  );

  /** The grocery list's id, or undefined while there is none. */
  readonly listId = computed(() => {
    const named = this.modules.kitchenConfig().groceryList;
    const note = named === undefined ? undefined : this.notes.find(named);
    if (note && !note.archived) return note.id;
    const template = this.template();
    // The notes are newest first, so this is the one last written in.
    return template
      ? this.notes.notes().find((n) => n.fromTemplate === template.id && !n.archived)?.id
      : undefined;
  });

  /**
   * Makes the grocery list: the Shopping list template if missing, and
   * its living note, named in Kitchen's settings. Returns its id.
   */
  makeList(): string {
    const existing = this.listId();
    if (existing) return existing;
    const id = this.templates.makeShoppingListNote(this.template()?.id);
    this.modules.configureKitchen({ groceryList: id });
    return id;
  }

  /**
   * One slot changed from `before` to `after` (#130). Returns how many
   * lines went on and off the list, or undefined if there is no list.
   */
  replan(
    before: Slot | undefined,
    after: Slot | undefined,
    label: string,
    /** The plan's other slots, for items another dinner still needs. */
    others: readonly Slot[] = [],
  ): { added: number; removed: number } | undefined {
    const list = this.notes.find(this.listId() ?? '');
    if (!list) return undefined;
    const from = this.dinner(before, label);
    const to = this.dinner(after, label);
    if (!from && !to) return { added: 0, removed: 0 };
    const config = this.modules.kitchenConfig();
    const sections = listSections(list.body);
    const rest = others
      .map((s) => this.dinner(s, mealLabel(s.day, s.meal)))
      .filter((d): d is PlannedDinner => !!d);
    const remembered = { ...config.sections, ...sections };
    const next = replanGrocery(list.body, from, to, remembered, new Set(), rest);
    if (next.body !== list.body) this.notes.save(list.id, next.body, { base: list.body });
    this.remember(sections);
    return { added: next.added, removed: next.removed };
  }

  /** Where the list files things now, kept for when they come back (#130). */
  remember(sections: Record<string, string>): void {
    const known = this.modules.kitchenConfig().sections;
    if (Object.entries(sections).every(([k, v]) => known[k] === v)) return;
    this.modules.configureKitchen({ sections: { ...known, ...sections } });
  }

  private dinner(slot: Slot | undefined, label: string): PlannedDinner | undefined {
    if (!slot?.recipe) return undefined;
    const id = this.notes.names().get(normalizeName(slot.recipe));
    const recipe = id === undefined ? undefined : this.notes.find(id);
    if (recipe?.kind !== 'recipe') return undefined;
    return { recipe: slot.recipe, recipeBody: recipe.body, day: label, ratio: slot.ratio };
  }
}
