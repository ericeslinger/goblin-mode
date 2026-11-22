import { Component, computed, inject, input, model } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  HABIT_CHOICES_MAX,
  HABIT_CHOICE_MAX,
  type HabitAnswer,
  habitAnswerLine,
  habitChoicesProblem,
} from '@mossgoblin/schema';
import { TemplatesService } from '../templates/templates.service';
import { ANSWER_CHOICES } from './habit-lines';

/**
 * "Answered with" (#324 step 6, 2026-11-22), in the add form and Edit:
 * Just done, One of a list, A line of text or A note, a select as How
 * often is. For a list, its choices, each a line of 1 to 40 characters,
 * with Up and Remove, and Add a choice up to 12; a repeat, or too few,
 * is said under them. For a note, one of the gardener's templates, as
 * From template lists them; none yet points to Settings, Templates. The
 * form saves only what `answerFields` takes.
 */
@Component({
  selector: 'app-habit-answer-fields',
  imports: [RouterLink],
  template: `
    <label>
      Answered with
      <select name="answer" (change)="choose($any($event.target).value)">
        @for (a of kinds; track a.value) {
          <option [value]="a.value" [selected]="answer() === a.value">{{ a.label }}</option>
        }
      </select>
    </label>
    @if (answer() === 'choice') {
      <fieldset class="choices">
        <legend>Choices</legend>
        <ol>
          @for (c of choices(); track $index; let i = $index) {
            <li>
              <input
                type="text"
                autocomplete="off"
                [attr.maxlength]="choiceMax"
                [attr.aria-label]="'Choice ' + (i + 1)"
                [attr.aria-describedby]="problem() ? problemId() : null"
                [value]="c"
                (input)="setChoice(i, $any($event.target).value)"
              />
              @if (i > 0) {
                <button
                  type="button"
                  class="link"
                  [attr.aria-label]="'Move choice ' + (i + 1) + ' up'"
                  (click)="move(i)"
                >
                  Up
                </button>
              }
              <button
                type="button"
                class="link"
                [attr.aria-label]="'Remove choice ' + (i + 1)"
                (click)="remove(i)"
              >
                Remove
              </button>
            </li>
          }
        </ol>
        @if (choices().length < choicesMax) {
          <button type="button" (click)="addChoice()">Add a choice</button>
        }
        @if (problem(); as p) {
          <p class="hint" [id]="problemId()">{{ p }}</p>
        }
      </fieldset>
    }
    @if (answer() === 'note') {
      @if (templates.templates().length) {
        <label>
          Template
          <select name="template" (change)="template.set($any($event.target).value || undefined)">
            <option value="" [selected]="!template()">Choose a template</option>
            @for (t of templates.templates(); track t.id) {
              <option [value]="t.id" [selected]="template() === t.id">
                {{ t.title || 'Untitled' }}
              </option>
            }
          </select>
        </label>
        <p class="hint">Ticking it opens a new note from the template.</p>
      } @else {
        <p class="hint">
          No templates yet: make one in
          <a routerLink="/settings/templates">Settings, Templates</a>.
        </p>
      }
    }
    @if (was() !== undefined && was() !== answer()) {
      <p class="hint">What is logged stays: earlier days keep what they hold.</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    select,
    input {
      display: block;
      width: 100%;
      box-sizing: border-box;
      margin-top: 4px;
      padding: 8px;
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
    }
    label {
      display: block;
      margin-top: var(--space-2, 8px);
    }
    fieldset {
      margin: var(--space-2, 8px) 0 0;
      padding: 0;
      border: 0;
    }
    legend {
      padding: 0;
    }
    ol {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      gap: var(--space-2, 8px);
      margin-top: 4px;
    }
    li input {
      flex: 1;
      min-width: 0;
      margin-top: 0;
    }
    li button {
      flex: none;
    }
    .choices > button {
      margin-top: var(--space-2, 8px);
    }
    .hint {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--quiet);
    }
  `,
})
export class HabitAnswerFields {
  readonly answer = model<HabitAnswer>('done');
  readonly choices = model<string[]>([]);
  readonly template = model<string | undefined>(undefined);
  /** The habit's answer as stored, in Edit: a change says what stays. */
  readonly was = input<HabitAnswer | undefined>(undefined);
  /** For the hint's id, unique on the page. */
  readonly for = input('new');
  protected readonly templates = inject(TemplatesService);
  protected readonly kinds = ANSWER_CHOICES;
  protected readonly choiceMax = HABIT_CHOICE_MAX;
  protected readonly choicesMax = HABIT_CHOICES_MAX;

  protected readonly problemId = computed(() => `choices-problem-${this.for()}`);
  /** What is wrong with the list as typed, once something is. */
  protected readonly problem = computed(() => {
    const list = this.choices().map((c) => habitAnswerLine(c, HABIT_CHOICE_MAX));
    return habitChoicesProblem(list);
  });

  protected choose(kind: HabitAnswer): void {
    this.answer.set(kind);
    if (kind === 'choice' && this.choices().length < 2) {
      this.choices.set([...this.choices(), '', ''].slice(0, Math.max(2, this.choices().length)));
    }
  }

  protected setChoice(i: number, value: string): void {
    this.choices.update((list) => list.map((c, j) => (j === i ? value : c)));
  }

  protected addChoice(): void {
    this.choices.update((list) => [...list, '']);
  }

  protected remove(i: number): void {
    this.choices.update((list) => list.filter((_, j) => j !== i));
  }

  protected move(i: number): void {
    this.choices.update((list) => {
      const next = [...list];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  }
}
