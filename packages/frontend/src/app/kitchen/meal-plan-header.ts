import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  type Slot,
  addDays,
  addSlotNote,
  localDate,
  mealLabel,
  normalizeName,
  planSlots,
  setMade,
  setSlot,
  shortDate,
} from '@mossgoblin/schema';
import { NOW } from '../platform/platform';
import { GroceryService } from './grocery.service';
import { RemindersService } from '../reminders/reminders.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';

/** What planning did to the grocery list, said under the week. */
function groceryNote({ added, removed }: { added: number; removed: number }): string {
  const lines = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;
  if (added && removed) return `Grocery list: ${lines(added)} on, ${lines(removed)} off.`;
  if (added) return `Added ${lines(added)} to the grocery list.`;
  if (removed) return `Took ${lines(removed)} off the grocery list.`;
  return '';
}

/** An hour, for "ask me later". */
const LATER_MS = 60 * 60 * 1000;

/**
 * Above a meal plan's text (#129): the week as slots. Tap one to plan a
 * recipe, delivery or out, or to clear it; tick it made. Once a dinner
 * is made it asks how it went (for a delivery, what it was and from
 * where), and the answer goes under the slot, and for a recipe in its
 * Notes too; "Later" asks again in an hour through a reminder. The text
 * stays the source of truth: every change is an edit of it, emitted to
 * the editor, so typing there is kept.
 */
@Component({
  selector: 'app-meal-plan-header',
  imports: [RouterLink],
  template: `
    <section class="plan" aria-label="Meal plan">
      <nav class="weeks" aria-label="Weeks">
        <a [routerLink]="['/kitchen', previous()]">Previous week</a>
        @if (grocery.listId(); as list) {
          <a [routerLink]="['/n', list]">Grocery list</a>
        } @else {
          <button type="button" (click)="makeList()">Make the grocery list</button>
        }
        <button type="button" class="link" (click)="openPantry()">On hand</button>
        <a [routerLink]="['/kitchen', next()]">Next week</a>
      </nav>
      <datalist id="recipe-names">
        @for (r of recipes(); track r.id) {
          <option [value]="r.title"></option>
        }
      </datalist>
      <ul class="slots" aria-label="Meals">
        @for (s of slots(); track s.line) {
          <li [class.today]="s.date === today()">
            <div class="row">
              <input
                type="checkbox"
                [checked]="s.made"
                [attr.aria-label]="'Made ' + label(s)"
                (change)="tick(s, $any($event.target).checked)"
              />
              <span class="when">{{ label(s) }}</span>
              @if (editing() === s.line) {
                <span class="edit">
                  <input
                    #pick
                    list="recipe-names"
                    placeholder="A recipe"
                    [attr.aria-label]="'Recipe for ' + label(s)"
                    [value]="s.recipe ?? ''"
                    (keydown.enter)="choose(s, pick.value)"
                  />
                  <button type="button" (click)="choose(s, pick.value)">Plan it</button>
                  <button type="button" (click)="set(s, 'delivery')">Delivery</button>
                  <button type="button" (click)="set(s, 'out')">Out</button>
                  <button type="button" (click)="set(s, '')">Clear</button>
                  <button type="button" (click)="editing.set(undefined)">Cancel</button>
                </span>
              } @else {
                <button
                  type="button"
                  class="what"
                  [attr.aria-label]="'Change ' + label(s) + ': ' + (s.text || 'nothing planned')"
                  (click)="editing.set(s.line); refused.set('')"
                >
                  {{ s.text || 'Nothing planned' }}
                </button>
              }
            </div>
            @for (n of s.notes; track $index) {
              <p class="note">{{ n }}</p>
            }
            @if (asking(s)) {
              <div class="ask">
                <label>
                  {{ question(s) }}
                  <input #answer [attr.aria-label]="question(s)" />
                </label>
                <button type="button" (click)="log(s, answer.value)">Save</button>
                <button type="button" (click)="later(s)">Ask me later</button>
              </div>
            }
          </li>
        }
      </ul>
      @if (refused()) {
        <p class="muted" role="status">{{ refused() }}</p>
      }
    </section>
  `,
  styles: `
    .plan {
      padding: var(--space-2) var(--space-3);
      border-bottom: 1px solid var(--rule);
      font-size: 14px;
    }
    .weeks {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      justify-content: space-between;
      margin-bottom: var(--space-1);
    }
    a {
      color: var(--accent);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      padding: var(--space-1) 0;
      border-bottom: 1px solid var(--rule);
    }
    li.today .when {
      font-weight: 600;
    }
    .row,
    .edit,
    .ask {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .when {
      min-width: 6.5em;
      color: var(--quiet);
    }
    .link {
      font: inherit;
      color: var(--accent);
      background: none;
      border: 0;
      padding: 0;
      text-decoration: underline;
      cursor: pointer;
    }
    .what {
      font: inherit;
      color: var(--ink);
      background: none;
      border: 0;
      padding: var(--space-1) 0;
      text-align: left;
      cursor: pointer;
      flex: 1;
    }
    .note {
      margin: 0 0 0 2em;
      color: var(--quiet);
    }
    .ask {
      margin: var(--space-1) 0 0 2em;
    }
    .ask label {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    input:not([type='checkbox']),
    button:not(.what):not(.link) {
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: var(--space-1) var(--space-2);
    }
    .muted {
      color: var(--quiet);
    }
  `,
})
export class MealPlanHeader {
  readonly note = input.required<NoteRecord>();
  /** The plan's text as the editor has it, typing included. */
  readonly body = input.required<string>();
  /** The plan's new text, for the editor to show and save. */
  readonly edited = output<string>();

  private readonly notes = inject(NotesService);
  protected readonly grocery = inject(GroceryService);
  private readonly router = inject(Router);
  private readonly reminders = inject(RemindersService);
  private readonly now = inject(NOW);

  protected readonly editing = signal<number | undefined>(undefined);
  protected readonly refused = signal('');
  /** Slots asked about later on this device, so the question waits. */
  private readonly deferred = signal<ReadonlySet<string>>(new Set());

  private readonly start = computed(() => this.note().periodStart ?? '');
  protected readonly slots = computed(() =>
    this.start() ? planSlots(this.body(), this.start()) : [],
  );
  protected readonly previous = computed(() => addDays(this.start(), -7));
  protected readonly next = computed(() => addDays(this.start(), 7));
  protected readonly today = computed(() => localDate(this.now()));
  protected readonly recipes = computed(() =>
    this.notes
      .notes()
      .filter((n) => n.kind === 'recipe' && !n.archived)
      .sort((a, b) => a.title.localeCompare(b.title)),
  );

  protected label(s: Slot): string {
    return `${s.day} ${s.meal}, ${shortDate(s.date)}`;
  }

  protected question(s: Slot): string {
    return s.kind === 'delivery'
      ? `What was it, and from where?`
      : `How did ${s.recipe ?? 'it'} go?`;
  }

  /** A made dinner with nothing noted under it yet, not put off. */
  protected asking(s: Slot): boolean {
    return (
      s.made &&
      (s.kind === 'recipe' || s.kind === 'delivery') &&
      s.notes.length === 0 &&
      !this.deferred().has(this.key(s))
    );
  }

  protected tick(s: Slot, made: boolean): void {
    this.edited.emit(setMade(this.body(), this.start(), s.day, s.meal, made));
    // Made: what it used is no longer on hand (#131). Unticking puts nothing back.
    if (made && !s.made) {
      const used = this.grocery.made(s);
      this.refused.set(used.length ? `Used up: ${used.join(', ')}.` : '');
    }
  }

  protected set(s: Slot, text: string): void {
    this.editing.set(undefined);
    const body = setSlot(this.body(), this.start(), s.day, s.meal, text);
    this.edited.emit(body);
    // The grocery list follows (#130): the old dinner's lines off, the new one's on.
    const slots = planSlots(body, this.start());
    const after = slots.find((x) => x.day === s.day && x.meal === s.meal);
    // Dinners already made need nothing more from the shop.
    const others = slots.filter((x) => x !== after && !x.made);
    const changed = this.grocery.replan(s, after, mealLabel(s.day, s.meal), others);
    this.refused.set(changed ? groceryNote(changed) : '');
  }

  /** What is on hand (#131), made the first time. */
  protected openPantry(): void {
    const id = this.notes.ensurePantry();
    if (id) void this.router.navigate(['/n', id]);
  }

  protected makeList(): void {
    void this.router.navigate(['/n', this.grocery.makeList()]);
  }

  /** A recipe by name: one that exists, or refused with a way to make it. */
  protected choose(s: Slot, name: string): void {
    const wanted = name.trim();
    if (!wanted) return;
    const id = this.notes.names().get(normalizeName(wanted));
    const recipe = id === undefined ? undefined : this.notes.find(id);
    if (recipe?.kind !== 'recipe') {
      this.refused.set(`No recipe is called “${wanted}”. Make it in Browse, Recipes first.`);
      return;
    }
    this.refused.set('');
    this.set(s, `[[${recipe.title}]]`);
  }

  protected log(s: Slot, answer: string): void {
    const text = answer.trim();
    if (!text) return;
    this.edited.emit(addSlotNote(this.body(), this.start(), s.day, s.meal, text));
    const id = s.recipe && this.notes.names().get(normalizeName(s.recipe));
    if (id) this.notes.addRecipeNote(id, `- ${shortDate(s.date)}: ${text}`);
  }

  /** Asks again in an hour, as a reminder that opens this plan. */
  protected later(s: Slot): void {
    this.reminders.add({
      text: `${this.question(s)} (${this.label(s)})`,
      dueAt: this.now() + LATER_MS,
      noteId: this.note().id,
    });
    this.deferred.update((d) => new Set([...d, this.key(s)]));
  }

  private key(s: Slot): string {
    return `${s.day} ${s.meal}`;
  }
}
