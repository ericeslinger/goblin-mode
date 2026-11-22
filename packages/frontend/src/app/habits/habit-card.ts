import { Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { type HabitAnswer, type HabitSchedule } from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { PushService } from '../push/push.service';
import { HabitAnswerFields } from './habit-answer-fields';
import { HabitAsk } from './habit-ask';
import {
  SCHEDULE_CHOICES,
  answerWords,
  dayInitial,
  dayName,
  dayState,
  habitWhen,
  latelyLine,
  nudgeHint,
  periodLine,
  streakLine,
} from './habit-lines';
import {
  type HabitShownAnswer,
  type PlacedHabit,
  HabitsService,
  answerFields,
} from './habits.service';

/**
 * One habit on the Habits screen (#324, step 2): its name, when it is
 * for and its streak as a plain line; the seven days ending today, each
 * a mark and words (never colour alone); today's Done and Skip, each
 * pressed while it is so, and pressed again to clear it; yesterday's
 * too, while it can still be logged; and Edit, for its name, how often
 * (step 5 of #324), its time and Archive. A weekly or monthly habit has
 * a line for its week or month ("Done this month, on the 3rd"), and no
 * Today row once that period was settled on another day. Edit has
 * Nudge me too (step 4 of #324), a switch that needs a time, turning
 * this device's notifications on the first time it is used, through
 * Settings' own path (PushService.enable). An archived habit keeps its
 * strip and has Unarchive. Archived or unarchived, it says so
 * (`moved`), so the screen can put the focus where the habit went
 * (review of #328, 2026-11-21).
 *
 * Answers (step 6 of #324, 2026-11-22): Edit has Answered with. A
 * choice or text habit's Done asks in place (HabitAsk) and the day's
 * answer shows on its row once given; a note habit's Done opens a new
 * entry from its template, and its row links to the entry. A choice
 * habit has a line of its last seven days' answers ("Lately: today
 * calm · Sat tired"), and every strip day's words carry its answer.
 */
@Component({
  selector: 'app-habit-card',
  imports: [HabitAnswerFields, HabitAsk, RouterLink],
  template: `
    @let h = habit();
    <div class="head">
      @if (level() === 3) {
        <h3 [id]="'habit-' + h.id">{{ h.name }}</h3>
      } @else {
        <h2 [id]="'habit-' + h.id">{{ h.name }}</h2>
      }
      @if (!h.archived) {
        <button
          type="button"
          class="quiet"
          [attr.aria-label]="'Edit ' + h.name"
          [attr.aria-expanded]="editing()"
          (click)="editing() ? editing.set(false) : edit()"
        >
          Edit
        </button>
      } @else {
        <button type="button" [attr.aria-label]="'Unarchive ' + h.name" (click)="unarchive()">
          Unarchive
        </button>
      }
    </div>
    @if (meta(); as m) {
      <p class="meta">{{ m }}</p>
    }
    <ol class="strip" [attr.aria-label]="'The last seven days of ' + h.name">
      @for (d of strip(); track d.day) {
        <li [class]="d.state" [title]="d.label">
          <span class="initial" aria-hidden="true">{{ d.initial }}</span>
          <span class="mark" aria-hidden="true">{{ d.mark }}</span>
          <span class="visually-hidden">{{ d.label }}</span>
        </li>
      }
    </ol>
    @if (period(); as p) {
      <p class="period">{{ p }}</p>
    }
    @if (lately(); as l) {
      <p class="lately">{{ l }}</p>
    }
    @if (!h.archived) {
      @for (r of rows(); track r.when) {
        <div class="log" role="group" [attr.aria-label]="r.label + ', ' + h.name">
          <span class="when">{{ r.label }}</span>
          <button
            type="button"
            [attr.aria-pressed]="r.state === 'done'"
            [attr.aria-expanded]="asks() ? isAsking(r.day) : null"
            [attr.aria-label]="'Done ' + r.when + ': ' + h.name"
            (click)="done(r.day, r.state)"
          >
            Done
          </button>
          <button
            type="button"
            [attr.aria-pressed]="r.state === 'skipped'"
            [attr.aria-label]="'Skip ' + r.when + ': ' + h.name"
            (click)="toggle(r.day, r.state, 'skipped')"
          >
            Skip
          </button>
          @if (shown(r.answer); as a) {
            @if (a.noteId) {
              <a class="answer" [routerLink]="['/n', a.noteId]">Open the entry</a>
            } @else if (a.sealed) {
              <span class="answer muted">Sealed: it cannot be opened on this device.</span>
            } @else if (a.text) {
              <span class="answer">{{ a.text }}</span>
            }
          }
        </div>
        @if (isAsking(r.day)) {
          <app-habit-ask [habit]="h" [day]="r.day" [when]="r.when" (closed)="asking.set(null)" />
        }
      }
    }
    @if (editing() && !h.archived) {
      <form class="edit" [attr.aria-label]="'Edit ' + h.name" (submit)="save($event)">
        <label>
          Name
          <input
            type="text"
            name="name"
            autocomplete="off"
            maxlength="80"
            [value]="name()"
            (input)="name.set(value($event))"
          />
        </label>
        <label>
          How often
          <select name="schedule" (change)="schedule.set($any(value($event)))">
            @for (s of schedules; track s.value) {
              <option [value]="s.value" [selected]="schedule() === s.value">{{ s.label }}</option>
            }
          </select>
        </label>
        @if (schedule() !== h.schedule) {
          <p class="hint">What is logged stays, read again by the new schedule.</p>
        }
        <label>
          Time of day <span class="hint">(leave empty for any time)</span>
          <input type="time" name="time" [value]="time()" (input)="time.set(value($event))" />
        </label>
        <label class="nudge">
          <input
            type="checkbox"
            role="switch"
            name="nudge"
            [attr.aria-describedby]="'nudge-hint-' + h.id"
            [checked]="nudge() && !!time()"
            [disabled]="!time()"
            (change)="nudgeTo($any($event.target).checked)"
          />
          Nudge me
        </label>
        <p class="hint" [id]="'nudge-hint-' + h.id">{{ hint() }}</p>
        <app-habit-answer-fields
          [(answer)]="answer"
          [(choices)]="choices"
          [(template)]="template"
          [was]="h.answer"
          [for]="h.id"
        />
        @if (nudge() && time() && pushOff()) {
          <p class="hint">
            This device gets no notifications:
            <a routerLink="/settings/notifications">Settings, Notifications</a>.
          </p>
        }
        <div class="actions">
          <button type="submit" class="primary" [disabled]="!name().trim() || !answerOk()">
            Save
          </button>
          <button type="button" (click)="archive()">Archive</button>
          <button type="button" class="link" (click)="editing.set(false)">Cancel</button>
        </div>
      </form>
    }
  `,
  styles: `
    :host {
      display: block;
      padding: var(--space-3) 0;
      border-bottom: 1px solid var(--rule);
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
    }
    h2,
    h3 {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-size: 17px;
      overflow-wrap: anywhere;
    }
    .meta {
      margin: 2px 0 0;
      font-size: 14px;
      color: var(--quiet);
    }
    .strip {
      display: flex;
      gap: 6px;
      margin: var(--space-2) 0 0;
      padding: 0;
      list-style: none;
    }
    .strip li {
      display: grid;
      justify-items: center;
      gap: 2px;
      width: 30px;
    }
    .initial {
      font-size: 12px;
      color: var(--quiet);
    }
    /* Each day a ring; done filled with the accent; the mark inside
       says the state too, and the words are there for a reader. */
    .mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 26px;
      height: 26px;
      border: 2px solid var(--quiet);
      border-radius: 50%;
      font-size: 14px;
      line-height: 1;
      color: var(--ink);
    }
    .done .mark {
      color: var(--on-accent);
      background: var(--accent);
      border-color: var(--accent);
    }
    .covered .mark,
    .open .mark {
      border-style: dashed;
    }
    .before .mark {
      border-color: var(--rule);
    }
    .strip li:last-child .initial {
      font-weight: 600;
      color: var(--ink);
    }
    .log {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin-top: var(--space-2);
    }
    .log .when {
      min-width: 5.5em;
      font-size: 14px;
      color: var(--quiet);
    }
    .log button {
      font-size: 14px;
      border-radius: var(--radius-pill);
    }
    .log button[aria-pressed='true'] {
      font-weight: 600;
      border-color: var(--accent);
      background: var(--chip-bg);
    }
    .period,
    .lately {
      margin: var(--space-1, 4px) 0 0;
      font-size: 14px;
    }
    .lately {
      color: var(--quiet);
      overflow-wrap: anywhere;
    }
    .answer {
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .muted {
      color: var(--quiet);
    }
    .edit {
      margin-top: var(--space-2);
    }
    .edit input,
    .edit select {
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
    p.hint {
      margin: 4px 0 0;
    }
    .nudge {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      min-height: 44px;
      margin-top: var(--space-2);
    }
    .edit .nudge input {
      display: inline-block;
      width: auto;
      margin: 0;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      align-items: center;
      margin-top: var(--space-2);
    }
  `,
})
export class HabitCard {
  readonly habit = input.required<PlacedHabit>();
  /** Its heading's level: 2 among the habits, 3 under Archived. */
  readonly level = input(2);
  /** The habit is archived (true) or back (false); this card goes. */
  readonly moved = output<boolean>();
  protected readonly habits = inject(HabitsService);
  private readonly modules = inject(ModulesService);
  private readonly push = inject(PushService);

  protected readonly editing = signal(false);
  protected readonly name = signal('');
  protected readonly time = signal('');
  protected readonly nudge = signal(false);
  protected readonly schedule = signal<HabitSchedule>('daily');
  protected readonly schedules = SCHEDULE_CHOICES;
  protected readonly answer = signal<HabitAnswer>('done');
  protected readonly choices = signal<string[]>([]);
  protected readonly template = signal<string | undefined>(undefined);
  /** The day whose Done asks for its answer here, if one does. */
  protected readonly asking = signal<string | null>(null);

  /** The answer in the form is one the habit can hold. */
  protected readonly answerOk = computed(
    () => answerFields(this.answer(), this.choices(), this.template()) !== undefined,
  );

  /** A choice or text habit: its Done asks first. */
  protected readonly asks = computed(() => ['choice', 'text'].includes(this.habit().answer));

  /**
   * Today's row, unless its week or month was settled on another day
   * (the period line says why), and yesterday's while it can be logged.
   */
  protected readonly rows = computed(() => {
    const h = this.habit();
    const out: {
      when: 'today' | 'yesterday';
      label: string;
      day: string;
      state?: 'done' | 'skipped';
      answer?: HabitShownAnswer;
    }[] = [];
    if (!this.settledElsewhere()) {
      out.push({
        when: 'today',
        label: 'Today',
        day: this.habits.today(),
        state: h.today,
        answer: h.todayAnswer,
      });
    }
    if (h.yesterdayLoggable) {
      out.push({
        when: 'yesterday',
        label: 'Yesterday',
        day: this.habits.yesterday(),
        state: h.yesterday,
        answer: h.yesterdayAnswer,
      });
    }
    return out;
  });

  /** A choice habit's last seven days' answers, newest first. */
  protected readonly lately = computed(() => {
    const h = this.habit();
    return h.answer === 'choice' ? latelyLine(h.strip, this.habits.today()) : '';
  });

  /** What a nudge at the time in the form would do. */
  protected readonly hint = computed(() =>
    nudgeHint(this.schedule(), this.time(), this.modules.habitsConfig()),
  );

  /** This device cannot be sent a nudge as things stand. */
  protected readonly pushOff = computed(() =>
    ['off', 'blocked', 'unsupported', 'unconfigured', 'error'].includes(this.push.state()),
  );

  protected readonly meta = computed(() => {
    const h = this.habit();
    return [
      habitWhen(h, this.modules.habitsConfig(), 'screen'),
      ...(h.streak ? [streakLine(h.schedule, h.streak.count, h.streak.complete)] : []),
    ]
      .filter(Boolean)
      .join(' · ');
  });

  protected readonly strip = computed(() => {
    const h = this.habit();
    return h.strip.map((d) => {
      const { mark, words } = dayState(d.state, h.schedule);
      const answer = answerWords(d.answer);
      const said = answer ? `${words}, ${answer}` : words;
      return { ...d, mark, initial: dayInitial(d.day), label: `${dayName(d.day)}: ${said}` };
    });
  });

  /** A weekly or monthly habit settled on another day of its period. */
  protected readonly settledElsewhere = computed(() => {
    const h = this.habit();
    return !h.today && h.state !== 'none';
  });

  /** How a weekly or monthly habit's week or month stands; none archived. */
  protected readonly period = computed(() => {
    const h = this.habit();
    return h.archived ? '' : periodLine(h, this.habits.today());
  });

  /** Opens the form on the habit as it is now. */
  protected edit(): void {
    this.name.set(this.habit().name);
    this.time.set(this.habit().time ?? '');
    this.nudge.set(this.habit().nudge);
    this.schedule.set(this.habit().schedule);
    this.answer.set(this.habit().answer);
    this.choices.set([...(this.habit().choices ?? [])]);
    this.template.set(this.habit().template);
    this.editing.set(true);
  }

  /**
   * Nudge me switched: on, the first time, this device's notifications
   * are asked for, as Settings turns them on; the switch is saved with
   * the form.
   */
  protected nudgeTo(on: boolean): void {
    this.nudge.set(on);
    if (on && ['off', 'error'].includes(this.push.state())) void this.push.enable();
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /** Logs the day as `state`, or clears it when it is that already. */
  protected toggle(day: string, now: string | undefined, state: 'done' | 'skipped'): void {
    this.asking.set(null);
    if (now === state) this.habits.clear(this.habit(), day);
    else this.habits.log(this.habit(), day, state);
  }

  /** An answer as the row shows it: its note, sealed, or its text. */
  protected shown(
    a: HabitShownAnswer | undefined,
  ): { noteId?: string; sealed?: boolean; text?: string } | undefined {
    if (!a) return undefined;
    if ('noteId' in a) return { noteId: a.noteId };
    if ('sealed' in a) return { sealed: true };
    return { text: a.text };
  }

  protected isAsking(day: string): boolean {
    return this.asking() === day;
  }

  /**
   * Done (step 6 of #324): pressed while done, it clears the day; else a
   * choice or text habit asks for its answer here (pressed again, the
   * question goes), a note habit is logged done and its entry opens,
   * and a done-only one is logged done.
   */
  protected done(day: string, now: 'done' | 'skipped' | undefined): void {
    const h = this.habit();
    if (now === 'done') return this.toggle(day, now, 'done');
    if (this.asks()) {
      this.asking.set(this.isAsking(day) ? null : day);
      return;
    }
    if (h.answer === 'note' && h.template) {
      this.asking.set(null);
      this.habits.logNote(h, day);
      return;
    }
    this.toggle(day, now, 'done');
  }

  protected save(event: Event): void {
    event.preventDefault();
    const h = this.habit();
    const name = this.name().trim();
    if (!name) return;
    if (name !== h.name) this.habits.rename(h.id, name);
    if (this.schedule() !== h.schedule) this.habits.setSchedule(h.id, this.schedule());
    const choices = this.answer() === 'choice' ? this.choices() : undefined;
    const template = this.answer() === 'note' ? this.template() : undefined;
    if (
      this.answer() !== h.answer ||
      JSON.stringify(choices ?? null) !== JSON.stringify(h.choices ?? null) ||
      template !== h.template
    ) {
      this.habits.setAnswer(h.id, this.answer(), choices, template);
    }
    const time = this.time() || undefined;
    const nudge = this.nudge() && time !== undefined;
    if (time !== h.time) this.habits.setTime(h.id, time, nudge);
    else if (nudge !== h.nudge) this.habits.setNudge(h.id, nudge);
    this.editing.set(false);
  }

  protected archive(): void {
    this.habits.archive(this.habit().id, true);
    this.editing.set(false);
    this.moved.emit(true);
  }

  protected unarchive(): void {
    this.habits.archive(this.habit().id, false);
    this.moved.emit(false);
  }
}
