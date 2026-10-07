import { Injectable, computed, inject } from '@angular/core';
import { templateParts } from '@mossgoblin/schema';
import { NotesService } from '../notes/notes.service';

/** What a new template starts as: a name to change, and the section for Claude. */
export const NEW_TEMPLATE =
  'New template\n\n## Instructions for Claude\n\nHow to fill in or tidy notes made from this template.\n';

/** The shopping list (#39): meals first, then the store's sections. */
export const SHOPPING_LIST = [
  'Shopping list',
  '',
  '## Meal plan',
  '',
  '## Produce',
  '',
  '## Butcher',
  '',
  '## Dry goods',
  '',
  '## Instructions for Claude',
  '',
  'When Eric asks for help with his grocery list: read the Meal plan, then add what the',
  'meals need with add_lines, one "- [ ] item" per line, under Produce, Butcher or Dry goods.',
  'Skip what is already on the list, ticked or not. Keep his items and words as they are.',
  'Items with ★ are staples: they stay on the list from week to week.',
  '',
].join('\n');

/**
 * Templates (#38): notes of kind `template`. Using one opens the note
 * to write in: a living template's one note (made the first time), or
 * a fresh entry. Both start from the skeleton, without the instructions.
 */
@Injectable({ providedIn: 'root' })
export class TemplatesService {
  private readonly notes = inject(NotesService);

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
    this.notes.create(id, SHOPPING_LIST, { kind: 'template', templateMode: 'living' });
    return id;
  }

  /** A new template, `mode` living or entry; returns its id. */
  create(mode: 'living' | 'entry'): string {
    const id = this.notes.newId();
    this.notes.create(id, NEW_TEMPLATE, { kind: 'template', templateMode: mode });
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
    const text = templateParts(template.body).skeleton;
    this.notes.create(id, text, { fromTemplate: templateId });
    return { id, text };
  }
}
