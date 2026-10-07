import { Component, computed, inject, input, signal } from '@angular/core';
import { NotesService, type NoteRecord } from '../notes/notes.service';

const TYPES = [
  { id: 'person', label: 'Person' },
  { id: 'project', label: 'Project' },
  { id: 'other', label: 'Other' },
];

/**
 * A concept's name, type and other names, above its text (#30). Renaming
 * keeps the concept and its links: the old name becomes another name.
 */
@Component({
  selector: 'app-concept-header',
  template: `
    <section class="concept" aria-label="Concept">
      <div class="row">
        <label class="name">
          <span class="visually-hidden">Name</span>
          <input
            #name
            [value]="note().title"
            (change)="rename(name)"
            (keydown.enter)="name.blur()"
          />
        </label>
        <label class="type">
          <span class="visually-hidden">Type</span>
          <select #type (change)="notes.updateConcept(note().id, { conceptType: type.value })">
            @for (t of types; track t.id) {
              <option [value]="t.id" [selected]="t.id === kind()">{{ t.label }}</option>
            }
          </select>
        </label>
      </div>
      <div class="synonyms">
        <span class="label" id="also-called">Also called</span>
        <ul aria-labelledby="also-called">
          @for (s of synonyms(); track s) {
            <li>
              {{ s }}
              <button type="button" [attr.aria-label]="'Remove ' + s" (click)="remove(s)">×</button>
            </li>
          }
        </ul>
        <label>
          <span class="visually-hidden">Add another name</span>
          <input
            #other
            placeholder="Add a name"
            (keydown.enter)="add(other.value); other.value = ''"
          />
        </label>
      </div>
      @if (refusal()) {
        <p class="refusal" role="status">{{ refusal() }}</p>
      }
    </section>
  `,
  styles: `
    .concept {
      padding: var(--space-2) var(--space-3) 0;
      border-bottom: 1px solid var(--rule);
    }
    .row {
      display: flex;
      gap: var(--space-2);
      align-items: center;
    }
    .name {
      flex: 1;
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
    select,
    .synonyms input {
      font: inherit;
      font-size: 14px;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: var(--space-1) var(--space-2);
    }
    .synonyms {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-2);
      align-items: center;
      padding: var(--space-1) 0 var(--space-2);
      font-size: 14px;
    }
    .label {
      color: var(--quiet);
    }
    ul {
      display: contents;
      list-style: none;
    }
    li {
      padding: 0 var(--space-1) 0 var(--space-2);
      border-radius: var(--radius-pill);
      background: var(--chip-bg);
    }
    li button {
      border: 0;
      background: none;
      color: var(--quiet);
      font: inherit;
      cursor: pointer;
      min-width: 24px;
      min-height: 24px;
    }
    label {
      display: inline;
      margin: 0;
    }
    .refusal {
      margin: 0 0 var(--space-2);
      font-size: 14px;
      color: var(--quiet);
    }
  `,
})
export class ConceptHeader {
  protected readonly notes = inject(NotesService);
  readonly note = input.required<NoteRecord>();
  protected readonly types = TYPES;
  protected readonly kind = computed(() => this.note().conceptType ?? 'other');
  protected readonly synonyms = computed(() => this.note().synonyms ?? []);

  protected readonly refusal = signal('');

  protected rename(input: HTMLInputElement): void {
    const title = input.value.trim();
    // A concept always has a name: a blank one puts the old name back.
    if (!title) {
      input.value = this.note().title;
      return;
    }
    if (this.update({ title }).length) input.value = this.note().title;
  }

  protected add(name: string): void {
    if (!name.trim()) return;
    this.update({ synonyms: [...this.synonyms(), name] });
  }

  protected remove(name: string): void {
    this.update({ synonyms: this.synonyms().filter((s) => s !== name) });
  }

  private update(change: { title?: string; synonyms?: string[] }): string[] {
    const refused = this.notes.updateConcept(this.note().id, change);
    this.refusal.set(refused.length ? `“${refused.join('”, “')}” already names another note.` : '');
    return refused;
  }
}
