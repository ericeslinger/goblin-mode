import { Component, input } from '@angular/core';
import type { NoteRecord } from '../notes/notes.service';

/**
 * Above a template's text (#38): what a template is. Whether it is one
 * note reused or a new note each time, and its Instructions for Claude
 * (#111), are on the back of the note (#112).
 */
@Component({
  selector: 'app-template-header',
  template: `
    <section class="template" aria-label="Template">
      <p>
        A template{{ note().templateMode === 'living' ? ', one note reused' : '' }}. Notes made from
        it start from this text. Its Instructions for Claude are on the back.
      </p>
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
  `,
})
export class TemplateHeader {
  readonly note = input.required<NoteRecord>();
}
