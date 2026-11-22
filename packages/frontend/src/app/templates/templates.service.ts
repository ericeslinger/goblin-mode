import { Injectable, Injector, computed, inject } from '@angular/core';
import {
  FEELINGS_TEMPLATE,
  FEELINGS_TIMES,
  moodLine,
  shoppingListBody,
  shoppingListTitle,
  templateParts,
} from '@mossgoblin/schema';
import { HabitsService } from '../habits/habits.service';
import { ModulesService } from '../modules/modules.service';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import { RemindersService } from '../reminders/reminders.service';

/** What a new template starts as: a name to change, and the section for Claude. */
export const NEW_TEMPLATE =
  'New template\n\n## Instructions for Claude\n\nHow to fill in or tidy notes made from this template.\n';

/**
 * The shopping list (#39): the store's sections. Since #130 it is
 * Kitchen's grocery list: planned dinners add their ingredients.
 */
export const SHOPPING_LIST = [
  'Shopping list',
  '',
  '## Produce',
  '',
  '## Butcher',
  '',
  '## Dry goods',
  '',
  '## Instructions for Claude',
  '',
  'Planned dinners add their ingredients themselves (plan_meal), each line only the item,',
  'under the section the item went in last time or under From recipes. When Eric asks for',
  'something else, add it with add_lines, one "- [ ] item" per line, under Produce, Butcher',
  'or Dry goods. Skip what is already on the list, ticked or not. Keep his items and words as',
  'they are. Items with ★ are staples: they stay on the list from week to week.',
  '',
].join('\n');

/**
 * A template's text and fields as made: the instructions, written into
 * one body above, go in their own field (#111).
 */
function made(body: string, templateMode: 'living' | 'entry') {
  const { skeleton, instructions } = templateParts(body);
  return {
    body: `${skeleton}\n`,
    fields: { kind: 'template' as const, templateMode, instructions },
  };
}

/**
 * Whether a note is a feelings journal's template (#40): a template, a
 * new entry each time, open on this device, with a Moods line, as
 * Settings tells one is there (`hasFeelingsJournal`) and Browse,
 * Journal, tells an entry. Only the journal's template is made with a
 * Moods line; one made by hand with one reads as a journal too.
 */
export function isFeelingsJournal(n: NoteRecord): boolean {
  return (
    n.kind === 'template' &&
    !n.archived &&
    !n.locked &&
    n.templateMode !== 'living' &&
    n.body.split('\n').some((line) => moodLine(line) !== undefined)
  );
}

/**
 * Templates (#38): notes of kind `template`. Using one opens the note
 * to write in: a living template's one note (made the first time), or
 * a fresh entry. Both start from the skeleton, without the instructions.
 */
@Injectable({ providedIn: 'root' })
export class TemplatesService {
  private readonly notes = inject(NotesService);
  /**
   * Reminders, habits and modules only when a journal is made, so
   * templates need none of their stores.
   */
  private readonly injector = inject(Injector);

  /** Live templates, by name. */
  readonly templates = computed(() =>
    this.notes
      .notes()
      .filter((n) => n.kind === 'template' && !n.archived)
      .sort((a, b) => a.title.localeCompare(b.title)),
  );

  /** The shopping list template, a living one; returns its id. */
  createShoppingList(): string {
    const id = this.notes.newId();
    const { body, fields } = made(SHOPPING_LIST, 'living');
    this.notes.create(id, body, fields);
    return id;
  }

  /**
   * The feelings journal (#40): an entry template with a Moods line, and
   * at breakfast, lunch and dinner something that opens a new entry.
   * Since step 7 of #324 (2026-11-22), with Habits on, three daily
   * habits of the note kind on the template, named as the reminders
   * were, each nudged at its time; with Habits off (or its switch not
   * read yet), three daily reminders linked to it, as before. Habits is
   * never switched on for it. Returns the template's id.
   */
  createFeelingsJournal(): string {
    const id = this.notes.newId();
    const { body, fields } = made(FEELINGS_TEMPLATE, 'entry');
    this.notes.create(id, body, fields);
    if (this.injector.get(ModulesService).habits()) {
      const habits = this.injector.get(HabitsService);
      for (const { time, text } of FEELINGS_TIMES) {
        habits.add({ name: text, time, answer: 'note', template: id, nudge: true });
      }
      return id;
    }
    const reminders = this.injector.get(RemindersService);
    for (const { time, text } of FEELINGS_TIMES) {
      reminders.add({ text, repeat: 'daily', at: time, noteId: id });
    }
    return id;
  }

  /**
   * The shopping list's living note (#130): of the template given, or
   * of a new Shopping list template, made here with it. Written at once,
   * without waiting for the new template to come back from the cache.
   * Given its week (#207), it is that week's list, named for it, its
   * text `body` when given (a new week's, with the dinner just planned).
   */
  makeShoppingListNote(
    templateId?: string,
    week?: { start: string; id: string; body?: string },
  ): string {
    const found = templateId === undefined ? undefined : this.notes.find(templateId);
    const template = templateId ?? this.createShoppingList();
    // The text a use of it starts with, as `use` writes it.
    const body =
      week?.body ??
      (found?.kind === 'template'
        ? shoppingListBody(found.body, found.instructions)
        : shoppingListBody(SHOPPING_LIST));
    const id = week?.id ?? this.notes.newId();
    const named = week
      ? {
          periodStart: week.start,
          title: shoppingListTitle(week.start),
          titleSource: 'user' as const,
        }
      : {};
    this.notes.create(id, body, { fromTemplate: template, ...named });
    return id;
  }

  /** A new template, `mode` living or entry; returns its id. */
  create(mode: 'living' | 'entry'): string {
    const id = this.notes.newId();
    const { body, fields } = made(NEW_TEMPLATE, mode);
    this.notes.create(id, body, fields);
    return id;
  }

  /**
   * The note to open for a template, with its text: its living note, or
   * a new entry from the skeleton. The text comes back too, so the note
   * opens with it before the new note reaches the list.
   */
  use(templateId: string): { id: string; text: string } | undefined {
    const template = this.notes.find(templateId);
    if (template?.kind !== 'template') return undefined;
    if (template.templateMode === 'living') {
      // The notes are newest first, so this is the one last written in.
      const living = this.notes.notes().find((n) => n.fromTemplate === templateId && !n.archived);
      if (living) return { id: living.id, text: living.body };
    }
    const id = this.notes.newId();
    const text = templateParts(template.body, template.instructions).skeleton;
    this.notes.create(id, text, { fromTemplate: templateId });
    return { id, text };
  }
}
