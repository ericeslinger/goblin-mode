import { Component, inject, input } from '@angular/core';
import { NotesService, type NoteRecord } from '../notes/notes.service';

/**
 * Above a template's text (#38): what a template is, and whether it is
 * one note reused or a new note each time.
 */
@Component({
  selector: 'app-template-header',
  template: `
    <section class="template" aria-label="Template">
      <p>
        A template. Notes made from it start from this text, without the Instructions for Claude
        section, which tells Claude how to fill them in.
      </p>
      <label>
        Each use
        <select #mode (change)="setMode(mode.value)">
          <option value="entry" [selected]="note().templateMode !== 'living'">
            makes a new note
          </option>
          <option value="living" [selected]="note().templateMode === 'living'">
            opens the same note
          </option>
        </select>
      </label>
    </section>
  `,
  styles: `
    .template {
      padding: var(--space-2) var(--space-3) 0;
      font-size: 14px;
      color: var(--quiet);
    }
    p {
      margin: 0 0 var(--space-1);
    }
    select {
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: 2px var(--space-1);
    }
  `,
})
export class TemplateHeader {
  readonly note = input.required<NoteRecord>();
  private readonly notes = inject(NotesService);

  protected setMode(mode: string): void {
    this.notes.setTemplateMode(this.note().id, mode === 'living' ? 'living' : 'entry');
  }
}
