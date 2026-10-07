import { Injectable, computed, inject } from '@angular/core';
import { templateParts } from '@mossgoblin/schema';
import { NotesService } from '../notes/notes.service';

/** What a new template starts as: a name to change, and the section for Claude. */
export const NEW_TEMPLATE =
  'New template\n\n## Instructions for Claude\n\nHow to fill in or tidy notes made from this template.\n';

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

  /** A new template, `mode` living or entry; returns its id. */
  create(mode: 'living' | 'entry'): string {
    const id = this.notes.newId();
    this.notes.create(id, NEW_TEMPLATE, { kind: 'template', templateMode: mode });
    return id;
  }

  /** The id of the note to open for a template: its living note, or a new entry. */
  use(templateId: string): string | undefined {
    const template = this.notes.find(templateId);
    if (template?.kind !== 'template') return undefined;
    if (template.templateMode === 'living') {
      // The notes are newest first, so this is the one last written in.
      const living = this.notes.notes().find((n) => n.fromTemplate === templateId && !n.archived);
      if (living) return living.id;
    }
    const id = this.notes.newId();
    this.notes.create(id, templateParts(template.body).skeleton, { fromTemplate: templateId });
    return id;
  }
}
