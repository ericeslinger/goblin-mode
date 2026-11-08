import { Injectable, computed, inject } from '@angular/core';
import {
  PANTRY_BODY,
  PANTRY_ID,
  type ItemSource,
  type PlannedDinner,
  addBought,
  checklist,
  isIsoDate,
  listIsOlder,
  listSources,
  localDate,
  onHand,
  planSlots,
  planStartFor,
  pruneWrote,
  recipeKeys,
  shoppingListBody,
  shoppingListId,
  slotKey,
  useUp,
  SHOPPING_LIST_NAME,
  type Slot,
  listSections,
  mealLabel,
  normalizeName,
  replanGrocery,
} from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { TemplatesService } from '../templates/templates.service';

/**
 * The grocery list the meal plan feeds (#130): the note Kitchen's
 * settings name, else the living note of the Shopping list template.
 * Planning a dinner adds its ingredients there; changing or clearing it
 * takes the old dinner's untouched lines off. Written through the
 * persistent cache like any note, so it works offline. Since #207 each
 * week has its own list: the first dinner planned into a newer week
 * starts one and archives the last; Kitchen records the lines each
 * dinner wrote, so only those come off; and the list's back says which
 * dinners want each item.
 */
@Injectable({ providedIn: 'root' })
export class GroceryService {
  private readonly notes = inject(NotesService);
  private readonly modules = inject(ModulesService);
  private readonly templates = inject(TemplatesService);
  private readonly now = inject(NOW);

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
   * its living note, named in Kitchen's settings. It is the list for the
   * week starting `start` (#207), this week's unless given. Returns its id.
   */
  makeList(start = this.thisWeek()): string {
    const existing = this.listId();
    if (existing) return existing;
    const id = this.templates.makeShoppingListNote(this.template()?.id, {
      start,
      id: this.freshId(start),
    });
    this.modules.configureKitchen({ groceryList: id });
    return id;
  }

  /** Whether a note is a grocery list (#207): Kitchen's, or made from the Shopping list. */
  isList(note: NoteRecord): boolean {
    const template = this.template();
    return (
      note.id === this.modules.kitchenConfig().groceryList ||
      (!!template && note.fromTemplate === template.id)
    );
  }

  /**
   * For a list's back (#207): its week, and which of that week's planned
   * dinners, not yet made, need each open item. Worked out from the plan
   * and the recipes each time; nothing is stored. A list from before
   * #207 has no week of its own and reads as this week's.
   */
  sources(note: NoteRecord): { start: string; items: ItemSource[] } {
    const start = note.periodStart ?? this.thisWeek();
    const plan = this.notes
      .notes()
      .find((n) => n.kind === 'mealplan' && !n.archived && n.periodStart === start);
    const dinners = plan
      ? planSlots(plan.body, start)
          .filter((s) => !s.made)
          .map((s) => this.dinner(s, mealLabel(s.day, s.meal)))
          .filter((d): d is PlannedDinner => !!d)
      : [];
    return { start, items: listSources(note.body, dinners) };
  }

  /** The first day of this week's plan, as /kitchen opens it. */
  private thisWeek(): string {
    const plans = this.notes
      .notes()
      .filter((n) => n.kind === 'mealplan' && !n.archived && n.periodStart)
      .map((n) => n.periodStart!)
      .filter(isIsoDate);
    return planStartFor(localDate(this.now()), this.modules.kitchenConfig().weekStart, plans);
  }

  /** The week's list's id, or a fresh one when a note already has it. */
  private freshId(start: string): string {
    const id = shoppingListId(start);
    return this.notes.exists(id) ? this.notes.newId() : id;
  }

  /**
   * One slot of the plan starting `start` changed from `before` to
   * `after` (#130). Returns how many lines went on and off the list, or
   * undefined if there is no list. Only the lines Kitchen recorded this
   * slot's dinner writing come off (`wrote`, #207), so Eric's own stay.
   *
   * The first dinner planned into a week newer than the list's (#207)
   * starts that week's list, from the Shopping list template with the
   * old list's staples, and archives the old one, never deleting it; its
   * lines go on the new list. A list from before #207, with no week, is
   * taken as the planned week's instead. Clearing a slot, or planning
   * the list's own week or an older one, leaves the list be.
   */
  replan(
    start: string,
    before: Slot | undefined,
    after: Slot | undefined,
    label: string,
    /** The plan's other slots, for items another dinner still needs. */
    others: readonly Slot[] = [],
  ): { added: number; removed: number } | undefined {
    const current = this.notes.find(this.listId() ?? '');
    if (!current) return undefined;
    const from = this.dinner(before, label, start);
    const to = this.dinner(after, label, start);
    if (!from && !to) return { added: 0, removed: 0 };
    let list: { id: string; body: string; start?: string } = {
      id: current.id,
      body: current.body,
      start: current.periodStart,
    };
    let make: string | undefined;
    if (to && !current.periodStart) {
      this.notes.setWeek(current.id, start);
      list.start = start;
    } else if (to && listIsOlder(current.periodStart, start)) {
      const week = this.weekList(current, start);
      if (week) {
        list = { id: week.id, body: week.body, start };
        make = week.template;
      }
    }
    const config = this.modules.kitchenConfig();
    const sections = listSections(list.body);
    const rest = others
      .map((s) => this.dinner(s, mealLabel(s.day, s.meal), start))
      .filter((d): d is PlannedDinner => !!d);
    const remembered = { ...config.sections, ...sections };
    // What is on hand is not shopped for (#131).
    const have = onHand(this.notes.find(PANTRY_ID)?.body ?? '');
    const next = replanGrocery(list.body, from, to, remembered, have, rest, config.wrote);
    if (make !== undefined) {
      this.templates.makeShoppingListNote(make, { start, id: list.id, body: next.body });
    } else if (next.body !== list.body) {
      this.notes.save(list.id, next.body, { base: list.body });
    }
    if (list.id !== current.id) this.notes.setArchived(current.id, true);
    this.modules.configureKitchen({
      sections: { ...config.sections, ...sections },
      wrote: pruneWrote(next.wrote, list.start),
      ...(list.id !== current.id ? { groceryList: list.id } : {}),
    });
    return { added: next.added, removed: next.removed };
  }

  /**
   * The list for the week starting `start` (#207), to follow `current`:
   * one another device or Claude started already, or the text a new one
   * starts with, from the template, with `current`'s staples. Undefined
   * without a template to make it from.
   */
  private weekList(
    current: NoteRecord,
    start: string,
  ): { id: string; body: string; template?: string } | undefined {
    const derived = this.notes.find(shoppingListId(start));
    if (derived && !derived.archived) return { id: derived.id, body: derived.body };
    const own = this.notes.find(current.fromTemplate ?? '');
    const template = own?.kind === 'template' ? own : this.template();
    if (!template) return undefined;
    return {
      id: this.freshId(start),
      body: shoppingListBody(template.body, template.instructions, current.body),
      template: template.id,
    };
  }

  /** Where the list files things now, kept for when they come back (#130). */
  remember(sections: Record<string, string>): void {
    const known = this.modules.kitchenConfig().sections;
    if (Object.entries(sections).every(([k, v]) => known[k] === v)) return;
    this.modules.configureKitchen({ sections: { ...known, ...sections } });
  }

  /**
   * Done shopping (#131): what was ticked on the list goes on hand, under
   * the section it was in. `listBody` is the list before it is cleared.
   */
  bought(listBody: string): string[] {
    const ticked = checklist(listBody).flatMap((s) =>
      s.items.filter((i) => i.done).map((i) => ({ text: i.text, section: s.heading })),
    );
    if (!ticked.length) return [];
    return this.editPantry((body) => addBought(body, ticked)) ?? [];
  }

  /** A dinner ticked made (#131): what its recipe used comes off, except `always`. */
  made(slot: Slot): string[] {
    const dinner = this.dinner(slot, slot.day);
    if (!dinner) return [];
    return (
      this.editPantry((body) => {
        const next = useUp(body, recipeKeys(dinner.recipeBody));
        return { body: next.body, added: next.used };
      }) ?? []
    );
  }

  /** Edits the pantry, made first if missing; returns what changed. */
  private editPantry(
    edit: (body: string) => { body: string; added: string[] },
  ): string[] | undefined {
    const id = this.notes.ensurePantry();
    if (!id) return undefined;
    const before = this.notes.find(id)?.body ?? PANTRY_BODY;
    const next = edit(before);
    if (next.body !== before) this.notes.save(id, next.body, { base: before });
    return next.added;
  }

  /** A slot's dinner; given its plan's first day, with its key in `wrote` (#207). */
  private dinner(slot: Slot | undefined, label: string, start?: string): PlannedDinner | undefined {
    if (!slot?.recipe) return undefined;
    const id = this.notes.names().get(normalizeName(slot.recipe));
    const recipe = id === undefined ? undefined : this.notes.find(id);
    if (recipe?.kind !== 'recipe') return undefined;
    return {
      recipe: slot.recipe,
      recipeBody: recipe.body,
      day: label,
      ratio: slot.ratio,
      ...(start ? { slot: slotKey(start, slot.day, slot.meal) } : {}),
    };
  }
}
