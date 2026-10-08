import { Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProjectKind, ProjectStatus, childrenOf, selfAndDescendants } from '@mossgoblin/schema';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { KINDS, STATUSES, kindLabel, statusLabel } from './project-labels';
import { RemindersService, type ReminderRecord } from '../reminders/reminders.service';

const TYPES = [
  { id: 'person', label: 'Person' },
  { id: 'project', label: 'Project' },
  { id: 'mood', label: 'Mood' },
  { id: 'other', label: 'Other' },
];

/**
 * A concept's name, type and other names, above its text (#30). Renaming
 * keeps the concept and its links: the old name becomes another name.
 * A project (#41) also has a parent, a kind and a status, lists the
 * projects under it, and shows its tasks: reminders linked to it.
 */
@Component({
  selector: 'app-concept-header',
  imports: [RouterLink],
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
          <select #type (change)="setType(type.value)">
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
          <!-- Added on change, which comes on Enter and on leaving the field:
               Android keyboards send no Enter keydown while composing, and
               closing the keyboard is how a phone finishes (Eric, 2026-10-08). -->
          <input
            #other
            placeholder="Add a name"
            enterkeyhint="done"
            (change)="add(other.value); other.value = ''"
          />
        </label>
      </div>
      @if (kind() === 'project') {
        <div class="project">
          <label>
            Parent
            <select #parent (change)="setParent(parent.value)">
              <option value="" [selected]="!note().parent">None</option>
              @for (p of parents(); track p.id) {
                <option [value]="p.id" [selected]="p.id === note().parent">{{ p.title }}</option>
              }
            </select>
          </label>
          <label>
            Kind
            <select
              #pkind
              (change)="notes.updateConcept(note().id, { projectKind: $any(pkind.value) })"
            >
              @if (!note().projectKind) {
                <option value="" selected disabled>Choose</option>
              }
              @for (k of kinds; track k.id) {
                <option [value]="k.id" [selected]="k.id === note().projectKind">
                  {{ k.label }}
                </option>
              }
            </select>
          </label>
          <label>
            Status
            <select
              #pstatus
              (change)="notes.updateConcept(note().id, { projectStatus: $any(pstatus.value) })"
            >
              @if (!note().projectStatus) {
                <option value="" selected disabled>Choose</option>
              }
              @for (s of statuses; track s.id) {
                <option [value]="s.id" [selected]="s.id === note().projectStatus">
                  {{ s.label }}
                </option>
              }
            </select>
          </label>
        </div>
        @if (children().length) {
          <div class="children">
            <h2 id="sub-projects">Projects in {{ note().title }}</h2>
            <ul aria-labelledby="sub-projects">
              @for (c of children(); track c.id) {
                <li>
                  <a [routerLink]="['/n', c.id]">{{ c.title }}</a>
                  <span class="meta">{{ meta(c) }}</span>
                </li>
              }
            </ul>
          </div>
        }
        <div class="tasks">
          <h2 id="project-tasks">Tasks</h2>
          @if (tasks().length) {
            <ul aria-labelledby="project-tasks">
              @for (t of tasks(); track t.id) {
                <li>
                  <span>{{ t.text }}</span>
                  <button type="button" [attr.aria-label]="'Done: ' + t.text" (click)="done(t)">
                    Done
                  </button>
                </li>
              }
            </ul>
          }
          <label>
            <span class="visually-hidden">Add a task</span>
            <input
              #task
              placeholder="+ task"
              enterkeyhint="done"
              (change)="addTask(task.value); task.value = ''"
            />
          </label>
        </div>
      }
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
    .project {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-3);
      padding-bottom: var(--space-2);
      font-size: 14px;
      color: var(--quiet);
    }
    .project select {
      margin-left: var(--space-1);
    }
    h2 {
      margin: 0 0 var(--space-1);
      font-size: 14px;
      font-weight: 600;
      color: var(--quiet);
    }
    .children ul,
    .tasks ul {
      display: block;
      margin: 0 0 var(--space-2);
      padding: 0;
    }
    .children li,
    .tasks li {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      padding: 0;
      background: none;
      font-size: 14px;
    }
    .meta {
      color: var(--quiet);
    }
    .tasks li button {
      min-height: 32px;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      color: var(--ink);
    }
    .tasks input {
      font: inherit;
      font-size: 14px;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: var(--space-1) var(--space-2);
      margin-bottom: var(--space-2);
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
  private readonly reminders = inject(RemindersService);
  readonly note = input.required<NoteRecord>();
  /** The concept became a project: its text needs the project sections. */
  readonly becameProject = output<void>();
  protected readonly types = TYPES;
  protected readonly kinds = KINDS;
  protected readonly statuses = STATUSES;
  private readonly projects = computed(() =>
    this.notes
      .notes()
      .filter((n) => n.kind === 'concept' && n.conceptType === 'project' && !n.archived),
  );
  /** Projects this one may go under: not itself, nor anything under it. */
  protected readonly parents = computed(() => {
    const below = selfAndDescendants(this.note().id, this.projects());
    return this.projects()
      .filter((p) => !below.has(p.id))
      .sort((a, b) => a.title.localeCompare(b.title));
  });
  protected readonly children = computed(() =>
    childrenOf(this.note().id, this.projects()).sort((a, b) => a.title.localeCompare(b.title)),
  );
  protected readonly tasks = computed(() =>
    this.reminders.reminders().filter((r) => r.noteId === this.note().id && r.status !== 'done'),
  );
  protected readonly kind = computed(() => this.note().conceptType ?? 'other');
  protected readonly synonyms = computed(() => this.note().synonyms ?? []);

  protected readonly refusal = signal('');

  protected setType(type: string): void {
    this.notes.updateConcept(this.note().id, { conceptType: type });
    if (type === 'project') this.becameProject.emit();
  }

  protected setParent(id: string): void {
    this.notes.updateConcept(this.note().id, { parent: id || null });
  }

  protected meta(p: NoteRecord): string {
    return [kindLabel(p.projectKind), statusLabel(p.projectStatus)].filter(Boolean).join(' · ');
  }

  protected addTask(text: string): void {
    if (!text.trim()) return;
    this.reminders.add({ text, noteId: this.note().id });
  }

  protected done(task: ReminderRecord): void {
    this.reminders.done(task);
  }

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
