import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { plainText } from '@mossgoblin/editor/grammar';
import {
  type Slot,
  addDays,
  addSlotNote,
  localDate,
  PANTRY_ID,
  type Suggestion,
  onHand,
  suggestRecipes,
  mealLabel,
  normalizeName,
  planSlots,
  setMade,
  setSlot,
  shortDate,
} from '@mossgoblin/schema';
import { Icon } from '../home/icon';
import { NOW } from '../platform/platform';
import { readPlan, weekLabel, wordlessLine } from './kitchen-lines';
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
 * A meal plan's week (#129), which since #288 (2026-11-15) is the
 * Meals tab's screen, the plan's text behind Edit as text: the week
 * between Previous and Next week, then the slots. Tap one to plan a
 * recipe, delivery or out, or to clear it; tick it made. Once a dinner
 * is made it asks how it went (for a delivery, what it was and from
 * where), and the answer goes under the slot, and for a recipe in its
 * Notes too; "Later" asks again in an hour through a reminder. The text
 * stays the source of truth: every change is an edit of it, emitted to
 * the editor, so typing there is kept.
 */
@Component({
  selector: 'app-meal-plan-header',
  imports: [Icon, RouterLink],
  template: `
    <section class="plan" aria-label="Meal plan">
      <!-- A plan with no first day has no week to draw: all it holds
           shows under Also in this plan (2026-11-16). -->
      @if (start()) {
        <!-- One row (#288, 2026-11-15): the week between its neighbours. -->
        <nav class="weeks" aria-label="Weeks">
          <a class="step" [routerLink]="['/kitchen', previous()]" aria-label="Previous week"
            ><app-icon name="chevron-left" [size]="22"
          /></a>
          <h2 class="week">{{ week() }}</h2>
          <a class="step" [routerLink]="['/kitchen', next()]" aria-label="Next week"
            ><app-icon name="chevron" [size]="22"
          /></a>
        </nav>
      }
      <div class="week-links">
        @if (grocery.listId(); as list) {
          <a class="secondary" [routerLink]="['/n', list]">Grocery list</a>
        } @else {
          <button type="button" class="secondary" (click)="makeList()">
            Make the grocery list
          </button>
        }
        <button type="button" class="secondary" (click)="openPantry()">On hand</button>
      </div>
      <datalist id="recipe-names">
        @for (r of recipes(); track r.id) {
          <option [value]="r.title"></option>
        }
      </datalist>
      @if (start()) {
        <ul class="slots" aria-label="Meals">
          @for (s of slots(); track s.line) {
            <li
              [class.today]="s.date === today()"
              [attr.aria-current]="s.date === today() ? 'date' : null"
            >
              <div class="row">
                <!-- Its tap area on a touch screen (2026-11-15). -->
                <label class="tick">
                  <input
                    type="checkbox"
                    [checked]="s.made"
                    [attr.aria-label]="'Made ' + label(s)"
                    (change)="tick(s, $any($event.target).checked)"
                  />
                </label>
                <!-- Separators in the text, so the day, Today and the dinner
                   never read run together; the comma is not drawn. -->
                <span class="when">{{ label(s) }}</span>
                @if (s.date === today()) {
                  <span class="visually-hidden">{{ ', ' }}</span>
                  <span class="today-word">Today</span>
                }
                <span class="visually-hidden">{{ ': ' }}</span>
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
                  @if (suggestionsFor(s); as ideas) {
                    @if (ideas.length) {
                      <ul class="ideas" [attr.aria-label]="'Suggestions for ' + label(s)">
                        @for (idea of ideas; track idea.id) {
                          <li>
                            <button
                              type="button"
                              class="link"
                              [attr.aria-label]="'Plan ' + idea.title"
                              (click)="set(s, '[[' + idea.title + ']]')"
                            >
                              {{ idea.title }}
                            </button>
                            <span class="muted">{{
                              idea.missing.length
                                ? 'needs ' + idea.missing.join(', ')
                                : 'all on hand'
                            }}</span>
                          </li>
                        }
                      </ul>
                    }
                  }
                } @else {
                  <!-- The slot's plain words (#285): [[Dal]] reads Dal. -->
                  <button
                    type="button"
                    class="what"
                    [attr.aria-label]="
                      'Change ' + label(s) + ': ' + (plain(s.text) || 'nothing planned')
                    "
                    (click)="editing.set(s.line); refused.set('')"
                  >
                    {{ plain(s.text) || 'Nothing planned' }}
                  </button>
                }
              </div>
              @for (n of s.notes; track $index) {
                <p class="note">{{ plain(n) }}</p>
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
      }
      @if (refused()) {
        <p class="muted" role="status">{{ refused() }}</p>
      }
      @if (extras().length || wordless()) {
        <!-- What the week cannot draw stays in sight (#288): plain words,
             and a count of the lines with none (2026-11-16). -->
        <section class="extras" aria-labelledby="plan-extras">
          <h3 id="plan-extras">Also in this plan</h3>
          @if (extras().length) {
            <ul aria-labelledby="plan-extras">
              @for (x of extras(); track x.line) {
                <li>{{ x.words }}</li>
              }
            </ul>
          }
          <p class="more-lines">
            @if (wordless()) {
              {{ wordless() }}
              <span aria-hidden="true">{{ ' · ' }}</span>
            }
            <button type="button" class="link" (click)="editText.emit()">Edit as text</button>
          </p>
        </section>
      }
    </section>
  `,
  styles: `
    .plan {
      padding: var(--space-2) var(--space-3);
      border-bottom: 1px solid var(--rule);
      font-size: 14px;
    }
    /* The week between its neighbours, one row, centred (#288). */
    .weeks {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
    }
    .step {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 44px;
      height: 44px;
      border-radius: var(--radius-control);
      color: var(--ink);
    }
    .step:hover {
      background: var(--chip-bg);
    }
    .week {
      margin: 0;
      min-width: 0;
      font-size: 17px;
      text-align: center;
    }
    .week-links {
      display: flex;
      justify-content: center;
      gap: var(--space-2);
      margin: var(--space-1) 0 var(--space-2);
    }
    a {
      color: var(--accent);
    }
    /* Secondary: the outline kind, a link drawn the same (#288). */
    .week-links .secondary {
      display: inline-flex;
      align-items: center;
      font: inherit;
      padding: 6px 12px;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      text-decoration: none;
      white-space: nowrap;
    }
    @media (pointer: coarse) {
      .week-links .secondary {
        min-height: 44px;
      }
    }
    /* Today, tinted, and said in words as well (#288). */
    li.today {
      margin: 0 calc(-1 * var(--space-2));
      padding-left: var(--space-2);
      padding-right: var(--space-2);
      background: var(--chip-bg);
      border-radius: var(--radius-control);
    }
    .today-word {
      padding: 0 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--ink);
      border: 1px solid var(--rule);
      border-radius: var(--radius-pill);
    }
    .extras {
      margin-top: var(--space-3);
    }
    .extras h3 {
      margin: 0 0 var(--space-1);
      font-size: 14px;
      color: var(--quiet);
    }
    .extras li {
      color: var(--quiet);
    }
    .more-lines {
      margin: var(--space-2) 0 0;
      color: var(--quiet);
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
    /* The text kind is global (styles.css); here it is underlined. */
    .link {
      text-decoration: underline;
    }
    .tick {
      display: contents;
    }
    /* A 22 px box in a 44 px tap area that takes no more room than the
       box does (2026-11-15). */
    @media (pointer: coarse) {
      .tick {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        /* Short of the gap on the right, so the day's name does not
           cover the area's edge. */
        margin: -11px -8px -11px -11px;
        cursor: pointer;
      }
      .tick input {
        width: 22px;
        height: 22px;
        margin: 0;
      }
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
    .ideas {
      flex-basis: 100%;
      display: grid;
      gap: var(--space-1);
      margin: var(--space-1) 0 0 2em;
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
    button:not(.what):not(.link):not(.secondary) {
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
    /* Suggestions part by what their tap areas add (2026-11-15). */
    @media (pointer: coarse) {
      .ideas {
        row-gap: 24px;
      }
    }
  `,
})
export class MealPlanHeader {
  readonly note = input.required<NoteRecord>();
  /** The plan's text as the editor has it, typing included. */
  readonly body = input.required<string>();
  /** The plan's new text, for the editor to show and save. */
  readonly edited = output<string>();
  /** Edit as text (#288), from the lines the week shows as plain words. */
  readonly editText = output<void>();

  private readonly notes = inject(NotesService);
  protected readonly grocery = inject(GroceryService);
  private readonly router = inject(Router);
  private readonly reminders = inject(RemindersService);
  private readonly now = inject(NOW);

  /**
   * A slot's plain words, shown, never stored: the text stays as typed
   * (#285). Kept per text: the header redraws with every keystroke in a
   * plan note, and a week's slots rarely change.
   */
  protected readonly plain = (text: string): string => {
    let known = this.plainOf.get(text);
    if (known === undefined) {
      if (this.plainOf.size >= 200) this.plainOf.clear();
      known = plainText(text);
      this.plainOf.set(text, known);
    }
    return known;
  };
  private readonly plainOf = new Map<string, string>();
  protected readonly editing = signal<number | undefined>(undefined);
  protected readonly refused = signal('');
  /** Slots asked about later on this device, so the question waits. */
  private readonly deferred = signal<ReadonlySet<string>>(new Set());

  private readonly start = computed(() => this.note().periodStart ?? '');
  protected readonly slots = computed(() =>
    this.start() ? planSlots(this.body(), this.start()) : [],
  );
  /** "Week of Nov 16" (#288). */
  protected readonly week = computed(() => (this.start() ? weekLabel(this.start()) : ''));
  /** The plan's lines the week cannot draw, as plain words (#288). */
  /** How the week accounts for the plan's lines (#288, 2026-11-16). */
  private readonly reading = computed(() => readPlan(this.body(), this.start()));
  /** The plan's lines the week cannot draw, as plain words. */
  protected readonly extras = computed(() => this.reading().extras);
  /** "1 more line without words", or ''. */
  protected readonly wordless = computed(() => wordlessLine(this.reading().wordless.length));
  protected readonly previous = computed(() => addDays(this.start(), -7));
  protected readonly next = computed(() => addDays(this.start(), 7));
  protected readonly today = computed(() => localDate(this.now()));
  protected readonly recipes = computed(() =>
    this.notes
      .notes()
      .filter((n) => n.kind === 'recipe' && !n.archived)
      .sort((a, b) => a.title.localeCompare(b.title)),
  );

  /** The pantry's items, for suggestions (#132). */
  private readonly have = computed(() => onHand(this.notes.find(PANTRY_ID)?.body ?? ''));

  /** The top three recipes to cook on a slot's day (#132). */
  protected suggestionsFor(s: Slot): Suggestion[] {
    return suggestRecipes(this.recipes(), this.notes.made(), this.have(), s.date, 3);
  }

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
    const changed = this.grocery.replan(this.start(), s, after, mealLabel(s.day, s.meal), others);
    this.refused.set(changed ? groceryNote(changed) : '');
  }

  /** What is on hand (#131), made the first time. */
  protected openPantry(): void {
    const id = this.notes.ensurePantry();
    if (id) void this.router.navigate(['/n', id]);
  }

  protected makeList(): void {
    void this.router.navigate(['/n', this.grocery.makeList(this.start() || undefined)]);
  }

  /** A recipe by name: one that exists, or refused with a way to make it. */
  protected choose(s: Slot, name: string): void {
    const wanted = name.trim();
    if (!wanted) return;
    const id = this.notes.names().get(normalizeName(wanted));
    const recipe = id === undefined ? undefined : this.notes.find(id);
    if (recipe?.kind !== 'recipe') {
      this.refused.set(`No recipe is called “${wanted}”. Add it in Kitchen, Recipes first.`);
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
