import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  afterRenderEffect,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';
import { PageHeader } from '../home/page-header';
import { ModulesService } from '../modules/modules.service';
import { SignIn } from '../sign-in/sign-in';
import type { HabitAnswer, HabitSchedule, Weekday } from '@mossgoblin/schema';
import { HabitAnswerFields } from './habit-answer-fields';
import { HabitCard } from './habit-card';
import { SCHEDULE_CHOICES, TIMES_CHOICES, WEEKDAY_CHOICES } from './habit-lines';
import { HabitRefusals } from './habit-refusals';
import { JournalOfferLine } from './journal-offer';
import { type HabitUndoable, HabitsService, answerFields } from './habits.service';

/**
 * The Habits screen (`/habits`, #324 step 2): each habit with its week
 * strip, its streak and today's Done and Skip; + adds one (a name, how
 * often, a time of day if any, and since step 6, 2026-11-22, what it
 * is answered with: done, one of a list, a line of text or a note);
 * Archived, under them, keeps each archived habit's history in view,
 * with Unarchive. A write the server refused is said under the Undo line,
 * with Try again (2026-11-21). Streaks are read back as far as they
 * run while this screen is open. Off, it says where to switch the
 * module on; until the modules are read, only that it is loading
 * (review of #328, 2026-11-21); signed out, only sign-in.
 *
 * Focus (review of #328): Undo pressed, or lapsing with the focus on
 * it, puts the focus on the Done of the day it undid; a habit archived
 * or unarchived takes the focus with it, to its Unarchive or its Edit
 * once it shows there.
 */
@Component({
  selector: 'app-habits',
  imports: [
    HabitAnswerFields,
    HabitCard,
    HabitRefusals,
    JournalOfferLine,
    PageHeader,
    RouterLink,
    SignIn,
  ],
  template: `
    @if (auth.user() === null) {
      <app-sign-in />
    } @else {
      <main class="page">
        <app-page-header title="Habits">
          @if (modules.habits() && !adding()) {
            <button type="button" class="add" aria-label="Add a habit" (click)="adding.set(true)">
              +
            </button>
          }
        </app-page-header>
        @if (!modules.loaded()) {
          <p class="muted" role="status">Loading…</p>
        } @else if (!modules.habits()) {
          <p>
            Habits is a module that is switched off.
            <a routerLink="/settings/modules">Switch it on in Settings, Modules</a>.
          </p>
        } @else {
          @if (adding()) {
            <form class="new" aria-label="New habit" (submit)="add($event)">
              <label>
                Habit
                <input
                  type="text"
                  name="name"
                  autocomplete="off"
                  maxlength="80"
                  enterkeyhint="done"
                  [value]="name()"
                  (input)="name.set(value($event))"
                  autofocus
                />
              </label>
              <label>
                How often
                <select name="schedule" (change)="schedule.set($any(value($event)))">
                  @for (s of schedules; track s.value) {
                    <option [value]="s.value" [selected]="schedule() === s.value">
                      {{ s.label }}
                    </option>
                  }
                </select>
              </label>
              @if (schedule() === 'weekly') {
                <label>
                  How many times a week
                  <select name="times" (change)="timesTo(+value($event))">
                    @for (n of timesChoices; track n.value) {
                      <option [value]="n.value" [selected]="times() === n.value">
                        {{ n.label }}
                      </option>
                    }
                  </select>
                </label>
                <label>
                  Which day
                  <select name="weekday" (change)="weekdayTo(value($event))">
                    @for (w of weekdayChoices; track w.value) {
                      <option [value]="w.value" [selected]="weekday() === w.value">
                        {{ w.label }}
                      </option>
                    }
                  </select>
                </label>
              }
              <label>
                Time of day <span class="hint">(optional)</span>
                <input type="time" name="time" [value]="time()" (input)="time.set(value($event))" />
              </label>
              <app-habit-answer-fields
                [(answer)]="answer"
                [(choices)]="choices"
                [(template)]="template"
              />
              <div class="actions">
                <button type="submit" class="primary" [disabled]="!name().trim() || !answerOk()">
                  Add
                </button>
                <button type="button" class="link" (click)="close()">Cancel</button>
              </div>
            </form>
          }
          <div role="status" class="status">
            @if (habits.undoable(); as last) {
              <span>{{ last.message }}</span>
              <button #undoButton type="button" class="link" (click)="undo()">Undo</button>
            }
          </div>
          <app-habit-refusals />
          <app-journal-offer />
          @if (habits.loaded() && !habits.active().length && !adding()) {
            <div class="empty">
              <p>
                A habit is something you mean to do every day, or once a week or a month: a walk, a
                page of reading, the watering, the gutters. It waits in Right Now until you tick it
                done or skip it for its day, week or month, and here you see its last seven days and
                how long it has kept going.
              </p>
              <button type="button" class="primary" (click)="adding.set(true)">
                Add your first habit
              </button>
            </div>
          }
          @if (habits.active().length) {
            <ul class="habits" aria-label="Habits">
              @for (h of habits.active(); track h.id) {
                <li><app-habit-card [habit]="h" (moved)="follow(h.name, $event)" /></li>
              }
            </ul>
          }
          @if (habits.archived().length) {
            <section aria-labelledby="habits-archived">
              <h2 id="habits-archived">Archived</h2>
              <ul class="habits" aria-labelledby="habits-archived">
                @for (h of habits.archived(); track h.id) {
                  <li>
                    <app-habit-card [habit]="h" [level]="3" (moved)="follow(h.name, $event)" />
                  </li>
                }
              </ul>
            </section>
          }
        }
      </main>
    }
  `,
  styles: `
    .add {
      font: inherit;
      font-size: 22px;
      line-height: 1;
      width: 40px;
      height: 40px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      color: var(--on-accent);
      background: var(--accent);
      cursor: pointer;
    }
    @media (pointer: coarse) {
      .add {
        width: 44px;
        height: 44px;
      }
    }
    .new {
      padding: 8px 0 16px;
      border-bottom: 1px solid var(--rule);
    }
    .new input,
    .new select {
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
    .hint {
      font-size: 13px;
      color: var(--quiet);
    }
    .actions {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-top: 12px;
    }
    .status:empty {
      display: none;
    }
    .status {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      padding: 6px 0;
      font-size: 14px;
      color: var(--quiet);
    }
    .muted {
      color: var(--quiet);
    }
    .empty p {
      color: var(--quiet);
    }
    ul.habits {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    h2 {
      margin: var(--space-4, 24px) 0 0;
      font-size: 15px;
      color: var(--quiet);
    }
  `,
})
export class Habits {
  protected readonly auth = inject(AuthService);
  protected readonly modules = inject(ModulesService);
  protected readonly habits = inject(HabitsService);
  protected readonly adding = signal(false);
  protected readonly name = signal('');
  protected readonly time = signal('');
  protected readonly schedule = signal<HabitSchedule>('daily');
  protected readonly schedules = SCHEDULE_CHOICES;
  /** A weekly habit's days a week (2026-11-23), 1 to 7: once unless chosen. */
  protected readonly times = signal(1);
  protected readonly timesChoices = TIMES_CHOICES;
  /** A weekly habit's own day (2026-11-25): '' is any day, unless chosen. */
  protected readonly weekday = signal<Weekday | ''>('');
  protected readonly weekdayChoices = WEEKDAY_CHOICES;
  protected readonly answer = signal<HabitAnswer>('done');
  protected readonly choices = signal<string[]>([]);
  protected readonly template = signal<string | undefined>(undefined);
  /** The answer in the form is one a habit can hold. */
  protected readonly answerOk = computed(
    () => answerFields(this.answer(), this.choices(), this.template()) !== undefined,
  );
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly undoButton = viewChild<ElementRef<HTMLButtonElement>>('undoButton');
  /** The button a habit archived or unarchived will have where it goes. */
  private readonly moving = signal<{ label: string } | null>(null);
  /** The Undo offered when last looked, to see it go. */
  private offered: HabitUndoable | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(this.habits.showStreaks());
    // Undo lapses (or a refusal takes it back) while it has the focus:
    // seen before the view drops the button.
    effect(() => {
      const now = this.habits.undoable();
      untracked(() => {
        const had = this.offered;
        this.offered = now;
        if (had && !now && this.undoButton()?.nativeElement === document.activeElement) {
          this.focusDay(had);
        }
      });
    });
    // A habit moved, once it shows where it went.
    afterRenderEffect(() => {
      const m = this.moving();
      this.habits.placed();
      if (!m) return;
      const button = this.button(m.label);
      if (!button) return;
      untracked(() => this.moving.set(null));
      button.focus();
    });
  }

  protected undo(): void {
    const had = this.habits.undoable();
    this.offered = null;
    this.habits.undo();
    if (had) this.focusDay(had);
  }

  protected follow(name: string, archived: boolean): void {
    this.moving.set({ label: `${archived ? 'Unarchive' : 'Edit'} ${name}` });
  }

  /** Focus to the Done of the day undone, once drawn. */
  private focusDay(u: HabitUndoable): void {
    const which = u.day === this.habits.yesterday() ? 'yesterday' : 'today';
    const name = this.habits.placed().find((h) => h.id === u.habit)?.name;
    afterNextRender(() => (name ? this.button(`Done ${which}: ${name}`) : undefined)?.focus(), {
      injector: this.injector,
    });
  }

  private button(label: string): HTMLButtonElement | undefined {
    return [...this.host.nativeElement.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === label,
    );
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /** More than once a week has no set day (2026-11-25): back to any day. */
  protected timesTo(n: number): void {
    this.times.set(n);
    if (n > 1) this.weekday.set('');
  }

  /** A set day is once a week (2026-11-25). */
  protected weekdayTo(w: string): void {
    this.weekday.set(w as Weekday | '');
    if (w) this.times.set(1);
  }

  protected add(event: Event): void {
    event.preventDefault();
    if (!this.name().trim()) return;
    this.habits.add({
      name: this.name(),
      schedule: this.schedule(),
      ...(this.schedule() === 'weekly' && this.times() > 1 ? { times: this.times() } : {}),
      ...(this.schedule() === 'weekly' && this.times() === 1 && this.weekday()
        ? { weekday: this.weekday() as Weekday }
        : {}),
      time: this.time() || undefined,
      answer: this.answer(),
      ...(this.answer() === 'choice' ? { choices: this.choices() } : {}),
      ...(this.answer() === 'note' && this.template() ? { template: this.template() } : {}),
    });
    this.close();
  }

  protected close(): void {
    this.name.set('');
    this.time.set('');
    this.schedule.set('daily');
    this.times.set(1);
    this.weekday.set('');
    this.answer.set('done');
    this.choices.set([]);
    this.template.set(undefined);
    this.adding.set(false);
  }
}
