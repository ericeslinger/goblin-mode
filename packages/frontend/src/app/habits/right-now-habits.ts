import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../home/icon';
import { ModulesService } from '../modules/modules.service';
import { HabitAsk } from './habit-ask';
import { habitWhen } from './habit-lines';
import { HabitRefusals } from './habit-refusals';
import { type HabitUndoable, type PlacedHabit, HabitsService } from './habits.service';
import { JournalHabitsService } from './journal-habits.service';

/**
 * Right Now's Habits (#324, step 2): today's habits not yet logged, a
 * round tick at the left (Done, as a reminder's) and Skip at the right;
 * one done or skipped leaves the list for the line under it, with Undo
 * for a few seconds. Yesterday, where it can still be logged and holds
 * nothing, is a quiet "Yesterday?" on the habit's row, which logs it
 * done; a skip of yesterday, or a change to it, is on the Habits
 * screen. A write the server refused is said under them, with Try
 * again (2026-11-21). Nothing shows while the module is off or there
 * is nothing of habits to show today.
 *
 * A habit answered with more than done (step 6 of #324, 2026-11-22):
 * its tick, or its Yesterday?, asks in place, a choice's buttons or a
 * line of text (HabitAsk); a note habit's tick logs it done and opens a
 * new entry from its template, as From template does.
 *
 * The row ticked goes, so the focus goes to its Undo; when Undo is
 * pressed or lapses with the focus on it, to the section's heading
 * (review of #328, 2026-11-21), never to the page.
 */
@Component({
  selector: 'app-right-now-habits',
  imports: [HabitAsk, HabitRefusals, Icon, RouterLink],
  template: `
    @if (shown()) {
      <section aria-labelledby="section-habits">
        <h2 id="section-habits">
          <a #heading routerLink="/habits" class="title">Habits</a>
        </h2>
        @if (habits.toDo().length) {
          <ul aria-labelledby="section-habits">
            @for (h of habits.toDo(); track h.id) {
              <li class="row">
                <button
                  type="button"
                  class="tick touch-target"
                  [attr.aria-label]="'Done: ' + h.name"
                  [attr.aria-expanded]="asks(h) ? isAsking(h, habits.today()) : null"
                  title="Done"
                  (click)="tick(h, habits.today())"
                >
                  <app-icon name="check" [size]="16" />
                </button>
                <span class="what">
                  <span class="text">{{ h.name }}</span>
                  @if (when(h); as w) {
                    <span class="when">{{ w }}</span>
                  }
                  @if (asking(); as a) {
                    @if (a.habit === h.id) {
                      <app-habit-ask
                        [habit]="h"
                        [day]="a.day"
                        [when]="a.day === habits.today() ? 'today' : 'yesterday'"
                        (closed)="answered($event)"
                      />
                    }
                  }
                </span>
                @if (h.yesterdayOpen) {
                  <button
                    type="button"
                    class="quiet"
                    [attr.aria-label]="'Yesterday? Mark ' + h.name + ' done yesterday'"
                    (click)="tick(h, habits.yesterday())"
                  >
                    Yesterday?
                  </button>
                }
                <button
                  type="button"
                  class="quiet"
                  [attr.aria-label]="'Skip: ' + h.name"
                  (click)="log(h, habits.today(), 'skipped')"
                >
                  Skip
                </button>
              </li>
            }
          </ul>
        }
        @if (settledLine(); as line) {
          <p class="settled">{{ line }}</p>
        }
        <div role="status" class="status">
          @if (habits.undoable(); as last) {
            <span>{{ last.message }}</span>
            <button #undoButton type="button" class="link" (click)="undo()">Undo</button>
          }
        </div>
        <app-habit-refusals />
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    h2 {
      margin: 20px 0 4px;
      font-size: 15px;
    }
    .title {
      color: var(--quiet);
      text-decoration: none;
    }
    .title:hover {
      text-decoration: underline;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--rule);
    }
    .what {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .text {
      color: var(--ink);
    }
    .when {
      display: block;
      font-size: 13px;
      color: var(--quiet);
    }
    .quiet {
      flex: none;
      font-size: 14px;
    }
    /* Right Now's tick, as a reminder's (#288): a ring in the quiet ink,
       the tick inside it faint until hovered or focused. */
    .tick {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 2px solid var(--quiet);
      border-radius: 50%;
      background: transparent;
    }
    .tick app-icon {
      opacity: 0.4;
    }
    .tick:hover app-icon,
    .tick:focus-visible app-icon {
      opacity: 1;
    }
    .settled {
      margin: 6px 0 0;
      font-size: 14px;
      color: var(--quiet);
      overflow-wrap: anywhere;
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
  `,
})
export class RightNowHabits {
  protected readonly habits = inject(HabitsService);
  private readonly modules = inject(ModulesService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly undoButton = viewChild<ElementRef<HTMLButtonElement>>('undoButton');
  private readonly heading = viewChild<ElementRef<HTMLAnchorElement>>('heading');
  /** The Undo offered when last looked, to see it go. */
  private offered: HabitUndoable | null = null;

  constructor() {
    // A feelings journal's move to habits cut short is finished on Right
    // Now too, not only on the Habits screen (step 7 of #324).
    inject(JournalHabitsService);
    // Undo lapses (or a refusal takes it back) while it has the focus:
    // seen before the view drops the button.
    effect(() => {
      const now = this.habits.undoable();
      untracked(() => {
        const had = this.offered;
        this.offered = now;
        if (had && !now && this.undoButton()?.nativeElement === document.activeElement) {
          this.focus(() => this.heading());
        }
      });
    });
  }

  /** Something due today, logged or not, an Undo still offered, or a refusal. */
  protected readonly shown = computed(
    () =>
      this.modules.habits() &&
      (this.habits.toDo().length > 0 ||
        this.habits.settled().length > 0 ||
        !!this.habits.undoable() ||
        this.habits.refusals().length > 0 ||
        this.habits.lostAnswers().length > 0),
  );

  /** "Done today: Floss, Stretch · Skipped today: Run". */
  protected readonly settledLine = computed(() => {
    const settled = this.habits.settled();
    const named = (state: 'done' | 'skipped') =>
      settled
        .filter((h) => h.state === state)
        .map((h) => h.name)
        .join(', ');
    const done = named('done');
    const skipped = named('skipped');
    return [
      ...(done ? [`Done today: ${done}`] : []),
      ...(skipped ? [`Skipped today: ${skipped}`] : []),
    ].join(' · ');
  });

  /**
   * The habit asking for its answer, and the day its tick or Yesterday?
   * was for (step 6 of #324): its row shows the choices or the line.
   */
  protected readonly asking = signal<{ habit: string; day: string } | null>(null);

  /** Logs the day; the row goes with it, so the focus goes to Undo. */
  protected log(h: PlacedHabit, day: string, state: 'done' | 'skipped'): void {
    this.asking.set(null);
    this.habits.log(h, day, state);
    this.focus(() => this.undoButton() ?? this.heading());
  }

  /** Whether a tick of `h` asks for an answer first (a choice or a line). */
  protected asks(h: PlacedHabit): boolean {
    return h.answer === 'choice' || h.answer === 'text';
  }

  protected isAsking(h: PlacedHabit, day: string): boolean {
    const a = this.asking();
    return a?.habit === h.id && a.day === day;
  }

  /**
   * A tick, or Yesterday? (step 6 of #324, 2026-11-22): a done-only habit
   * is logged done; a choice or text habit asks in place, pressed again
   * to put the question away; a note habit is logged done at the tap and
   * its entry opens from the template, the capture loop taking over.
   */
  protected tick(h: PlacedHabit, day: string): void {
    if (this.asks(h)) {
      this.asking.set(this.isAsking(h, day) ? null : { habit: h.id, day });
      return;
    }
    if (h.answer === 'note' && h.template) {
      this.asking.set(null);
      this.habits.logNote(h, day);
      return;
    }
    this.log(h, day, 'done');
  }

  /**
   * The answer given, or put away: the focus goes to Undo, or back to
   * the button that asked, today's tick or Yesterday? (review of #332,
   * 2026-11-22).
   */
  protected answered(how: 'answered' | 'cancelled'): void {
    const a = this.asking();
    this.asking.set(null);
    if (how === 'answered') this.focus(() => this.undoButton() ?? this.heading());
    else if (a) {
      const name = this.habits.placed().find((h) => h.id === a.habit)?.name;
      const label =
        a.day === this.habits.today() ? `Done: ${name}` : `Yesterday? Mark ${name} done yesterday`;
      this.focus(() => this.buttonNamed(label) ?? this.buttonNamed(`Done: ${name}`));
    }
  }

  private buttonNamed(label: string): ElementRef<HTMLElement> | undefined {
    const b = [...this.host.nativeElement.querySelectorAll('button')].find(
      (x) => x.getAttribute('aria-label') === label,
    );
    return b ? new ElementRef(b) : undefined;
  }

  protected undo(): void {
    this.offered = null;
    this.habits.undo();
    this.focus(() => this.heading());
  }

  /** Focus to `target`, once the view has drawn what took it away. */
  private focus(target: () => ElementRef<HTMLElement> | undefined): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }

  protected when(h: PlacedHabit): string {
    return habitWhen(h, this.modules.habitsConfig());
  }
}
