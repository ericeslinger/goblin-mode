import { Component, computed, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { checklist, childrenOf, selfAndDescendants, stageOrder } from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { KINDS, STATUSES, kindLabel, statusLabel } from './project-labels';
import { RemindersService, type ReminderRecord } from '../reminders/reminders.service';

/** `list` with `item` added, or taken out when it is there. */
function toggled(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

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
  imports: [NgTemplateOutlet, RouterLink],
  template: `
    <section
      class="concept"
      [class.on-back]="side() === 'back'"
      [attr.aria-label]="side() === 'back' ? 'Concept settings' : 'Concept'"
    >
      @if (side() === 'front') {
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
              @for (t of types(); track t.id) {
                <option [value]="t.id" [selected]="t.id === kind()">{{ t.label }}</option>
              }
            </select>
          </label>
        </div>
        <!-- The settings are on the back of the note (#112), so the page's
           items and text have the room (Eric, 2026-10-17). -->
        @if (summary(); as line) {
          <p class="summary meta">{{ line }}</p>
        }
      }
      @if (side() === 'back') {
        <div id="concept-details" class="details">
          <div class="synonyms">
            <span class="label" id="also-called">Also called</span>
            <ul aria-labelledby="also-called">
              @for (s of synonyms(); track s) {
                <li>
                  {{ s }}
                  <button type="button" [attr.aria-label]="'Remove ' + s" (click)="remove(s)">
                    ×
                  </button>
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
          @if (isProject()) {
            <div class="project">
              <label>
                Parent
                <select #parent (change)="setParent(parent.value)">
                  <option value="" [selected]="!note().parent">None</option>
                  @for (p of parents(); track p.id) {
                    <option [value]="p.id" [selected]="p.id === note().parent">
                      {{ p.title }}
                    </option>
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
            <!-- What this project's items move through and carry: data, so a
                 new stage needs no new app (Eric, 2026-10-17). -->
            <div class="synonyms">
              <span class="label" id="stages">Stages</span>
              <ul aria-labelledby="stages">
                @for (s of stages(); track s; let i = $index) {
                  <li>
                    @if (i > 0) {
                      <button
                        type="button"
                        [attr.aria-label]="'Move ' + s + ' earlier'"
                        (click)="moveStage(i)"
                      >
                        ‹
                      </button>
                    }
                    {{ s }}
                    <button
                      type="button"
                      [attr.aria-label]="'Remove stage ' + s"
                      (click)="setStages(without(stages(), s))"
                    >
                      ×
                    </button>
                  </li>
                }
              </ul>
              <label>
                <span class="visually-hidden">Add a stage</span>
                <input
                  #stage
                  placeholder="Add a stage"
                  enterkeyhint="done"
                  (change)="setStages([...stages(), stage.value]); stage.value = ''"
                />
              </label>
            </div>
            <div class="synonyms">
              <span class="label" id="item-tags">Item tags</span>
              <ul aria-labelledby="item-tags">
                @for (t of itemTags(); track t) {
                  <li>
                    {{ t }}
                    <button
                      type="button"
                      [attr.aria-label]="'Remove tag ' + t"
                      (click)="setItemTags(without(itemTags(), t))"
                    >
                      ×
                    </button>
                  </li>
                }
              </ul>
              <label>
                <span class="visually-hidden">Add an item tag</span>
                <input
                  #itag
                  placeholder="Add a tag"
                  enterkeyhint="done"
                  (change)="setItemTags([...itemTags(), itag.value]); itag.value = ''"
                />
              </label>
            </div>
          }
        </div>
      }
      @if (side() === 'front' && isProject()) {
        <div class="children">
          <h2 id="sub-projects">Projects in {{ note().title }}</h2>
          @if (children().length) {
            <ul aria-labelledby="sub-projects" class="items">
              @for (c of children(); track c.note.id) {
                <li>
                  <div class="item">
                    <a [routerLink]="['/n', c.note.id]">{{ c.note.title }}</a>
                    @if (c.meta) {
                      <span class="meta">{{ c.meta }}</span>
                    }
                    <span class="spacer"></span>
                    @if (stages().length) {
                      <ng-container
                        *ngTemplateOutlet="
                          stagePicker;
                          context: {
                            name: c.note.title,
                            current: c.note.stage,
                            pick: stageOf(c.note),
                          }
                        "
                      />
                    }
                  </div>
                  <ng-container
                    *ngTemplateOutlet="
                      tagLine;
                      context: {
                        key: c.note.id,
                        name: c.note.title,
                        tags: c.note.tags ?? [],
                        toggle: tagsOf(c.note),
                      }
                    "
                  />
                </li>
              }
            </ul>
          }
          <label>
            <span class="visually-hidden">Add a project in {{ note().title }}</span>
            <input
              #child
              placeholder="+ project"
              enterkeyhint="done"
              (change)="addChild(child.value); child.value = ''"
            />
          </label>
        </div>
        <div class="tasks">
          <h2 id="project-tasks">Tasks</h2>
          @if (tasks().length) {
            <ul aria-labelledby="project-tasks" class="items">
              @for (t of tasks(); track t.id) {
                <li>
                  <div class="item">
                    <span>{{ t.text }}</span>
                    <span class="spacer"></span>
                    @if (stages().length) {
                      <ng-container
                        *ngTemplateOutlet="
                          stagePicker;
                          context: { name: t.text, current: t.stage, pick: stageOfTask(t) }
                        "
                      />
                    }
                    <button
                      type="button"
                      class="done"
                      [attr.aria-label]="'Done: ' + t.text"
                      (click)="done(t)"
                    >
                      Done
                    </button>
                  </div>
                  <ng-container
                    *ngTemplateOutlet="
                      tagLine;
                      context: {
                        key: t.id,
                        name: t.text,
                        tags: t.tags ?? [],
                        toggle: tagsOfTask(t),
                      }
                    "
                  />
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

    <ng-template #stagePicker let-name="name" let-current="current" let-pick="pick">
      <label>
        <span class="visually-hidden">Stage of {{ name }}</span>
        <select #picked (change)="pick(picked.value)">
          <option value="" [selected]="!current">No stage</option>
          @for (s of stagesWith(current); track s) {
            <option [value]="s" [selected]="s === current">{{ s }}</option>
          }
        </select>
      </label>
    </ng-template>

    <ng-template #tagLine let-key="key" let-name="name" let-tags="tags" let-toggle="toggle">
      @if (itemTags().length) {
        <div class="tag-line">
          @for (t of itemTags(); track t) {
            @if (tags.includes(t) || tagging() === key) {
              <button
                type="button"
                class="tag"
                [attr.aria-pressed]="tags.includes(t)"
                [attr.aria-label]="t + ' on ' + name"
                [disabled]="tagging() !== key"
                (click)="toggle(t)"
              >
                {{ t }}
              </button>
            }
          }
          <button
            type="button"
            class="tag-edit"
            [attr.aria-label]="(tagging() === key ? 'Done tagging ' : 'Tag ') + name"
            (click)="tagging.set(tagging() === key ? undefined : key)"
          >
            {{ tagging() === key ? 'Done' : '+ tag' }}
          </button>
        </div>
      }
    </ng-template>
  `,
  styles: `
    .concept {
      padding: var(--space-2) var(--space-3) 0;
      border-bottom: 1px solid var(--rule);
    }
    .summary {
      margin: 0;
      padding-bottom: var(--space-2);
      font-size: 14px;
    }
    .concept.on-back {
      padding: 0;
      border-bottom: 0;
    }
    .tag-edit,
    .tag {
      font: inherit;
      font-size: 13px;
      color: var(--quiet);
      background: none;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-pill);
      padding: 2px 10px;
      min-height: 24px;
      cursor: pointer;
    }
    .tag[aria-pressed='true'] {
      color: var(--ink);
      background: var(--chip-bg);
    }
    .tag:disabled {
      cursor: default;
      opacity: 1;
    }
    .spacer {
      flex: 1;
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
    .items {
      display: block;
      margin: 0 0 var(--space-2);
      padding: 0;
    }
    .items > li {
      display: block;
      padding: var(--space-1) 0;
      border-radius: 0;
      border-bottom: 1px solid var(--rule);
      background: none;
      font-size: 14px;
    }
    .item {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      min-height: 36px;
    }
    .tag-line {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      padding-top: 2px;
    }
    .meta {
      color: var(--quiet);
    }
    .done {
      font: inherit;
      background: none;
      cursor: pointer;
      min-height: 32px;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      color: var(--ink);
    }
    .children input,
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
  /** The front: name, type and a project's items. The back: its settings (#112). */
  readonly side = input<'front' | 'back'>('front');
  /** The concept became a project: its text needs the project sections. */
  readonly becameProject = output<void>();
  private readonly modules = inject(ModulesService);
  /** Project is a type only while Projects is on, or for a concept that is one (#126). */
  protected readonly types = computed(() =>
    TYPES.filter((t) => t.id !== 'project' || this.modules.projects() || this.kind() === 'project'),
  );
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
  /** The project's own stages and item tags (2026-10-17). */
  protected readonly stages = computed(() => this.note().stages ?? []);
  protected readonly itemTags = computed(() => this.note().itemTags ?? []);
  /** Sub-projects in stage order, each with what is open on it. */
  protected readonly children = computed(() => {
    const open = new Map<string, number>();
    for (const r of this.reminders.reminders()) {
      if (r.noteId && r.status !== 'done') open.set(r.noteId, (open.get(r.noteId) ?? 0) + 1);
    }
    const unticked = (body: string) =>
      checklist(body).reduce((sum, s) => sum + s.items.filter((i) => !i.done).length, 0);
    return stageOrder(
      childrenOf(this.note().id, this.projects()),
      this.stages(),
      (c) => c.title,
    ).map((note) => {
      const count = (open.get(note.id) ?? 0) + unticked(note.body);
      const meta = [statusLabel(note.projectStatus), count ? `${count} open` : ''];
      return { note, meta: meta.filter(Boolean).join(' · ') };
    });
  });
  protected readonly tasks = computed(() =>
    stageOrder(
      this.reminders.reminders().filter((r) => r.noteId === this.note().id && r.status !== 'done'),
      this.stages(),
      () => '',
    ),
  );
  protected readonly kind = computed(() => this.note().conceptType ?? 'other');
  /** A project, shown as one: with Projects off, its settings and items stay hidden. */
  protected readonly isProject = computed(
    () => this.kind() === 'project' && this.modules.projects(),
  );
  protected readonly synonyms = computed(() => this.note().synonyms ?? []);

  protected readonly refusal = signal('');
  /** Name, type, other names and the project's settings: folded by default. */
  /** The item whose tags are being changed, if any. */
  protected readonly tagging = signal<string | undefined>(undefined);

  /** One line for the folded settings: a project's kind and status. */
  protected readonly summary = computed(() => (this.isProject() ? this.meta(this.note()) : ''));

  /** The stages, plus one an item still has that the project dropped. */
  protected stagesWith(current: string | undefined): string[] {
    const stages = this.stages();
    return current && !stages.includes(current) ? [...stages, current] : stages;
  }

  protected without(list: string[], item: string): string[] {
    return list.filter((x) => x !== item);
  }

  protected setStages(stages: string[]): void {
    this.notes.updateConcept(this.note().id, { stages });
  }

  protected setItemTags(itemTags: string[]): void {
    this.notes.updateConcept(this.note().id, { itemTags });
  }

  protected moveStage(i: number): void {
    const stages = [...this.stages()];
    [stages[i - 1], stages[i]] = [stages[i], stages[i - 1]];
    this.setStages(stages);
  }

  protected stageOf(item: NoteRecord) {
    return (stage: string) => this.notes.updateConcept(item.id, { stage: stage || null });
  }

  protected stageOfTask(task: ReminderRecord) {
    return (stage: string) => this.reminders.setItem(task, { stage: stage || null });
  }

  protected tagsOf(item: NoteRecord) {
    return (tag: string) =>
      this.notes.updateConcept(item.id, { tags: toggled(item.tags ?? [], tag) });
  }

  protected tagsOfTask(task: ReminderRecord) {
    return (tag: string) => this.reminders.setItem(task, { tags: toggled(task.tags ?? [], tag) });
  }

  protected addChild(name: string): void {
    this.notes.createItem(this.note().id, name);
  }

  protected setType(type: string): void {
    this.notes.updateConcept(this.note().id, { conceptType: type });
    if (type === 'project') this.becameProject.emit();
  }

  protected setParent(id: string): void {
    this.notes.updateConcept(this.note().id, { parent: id || null });
  }

  private meta(p: NoteRecord): string {
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
