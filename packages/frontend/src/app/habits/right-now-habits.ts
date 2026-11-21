import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../home/icon';
import { ModulesService } from '../modules/modules.service';
import { habitWhen } from './habit-lines';
import { type PlacedHabit, HabitsService } from './habits.service';

/**
 * Right Now's Habits (#324, step 2): today's habits not yet logged, a
 * round tick at the left (Done, as a reminder's) and Skip at the right;
 * one done or skipped leaves the list for the line under it, with Undo
 * for a few seconds. Yesterday, where it can still be logged and holds
 * nothing, is a quiet "Yesterday?" on the habit's row, which logs it
 * done; a skip of yesterday, or a change to it, is on the Habits
 * screen. Nothing shows while the module is off or there are no
 * habits due today.
 */
@Component({
  selector: 'app-right-now-habits',
  imports: [Icon, RouterLink],
  template: `
    @if (shown()) {
      <section aria-labelledby="section-habits">
        <h2 id="section-habits"><a routerLink="/habits" class="title">Habits</a></h2>
        @if (habits.toDo().length) {
          <ul aria-labelledby="section-habits">
            @for (h of habits.toDo(); track h.id) {
              <li class="row">
                <button
                  type="button"
                  class="tick touch-target"
                  [attr.aria-label]="'Done: ' + h.name"
                  title="Done"
                  (click)="habits.log(h, habits.today(), 'done')"
                >
                  <app-icon name="check" [size]="16" />
                </button>
                <span class="what">
                  <span class="text">{{ h.name }}</span>
                  @if (when(h); as w) {
                    <span class="when">{{ w }}</span>
                  }
                </span>
                @if (h.yesterdayOpen) {
                  <button
                    type="button"
                    class="quiet"
                    [attr.aria-label]="'Yesterday? Mark ' + h.name + ' done yesterday'"
                    (click)="habits.log(h, habits.yesterday(), 'done')"
                  >
                    Yesterday?
                  </button>
                }
                <button
                  type="button"
                  class="quiet"
                  [attr.aria-label]="'Skip: ' + h.name"
                  (click)="habits.log(h, habits.today(), 'skipped')"
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
            <button type="button" class="link" (click)="habits.undo()">Undo</button>
          }
        </div>
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

  /** Something due today, logged or not, or an Undo still offered. */
  protected readonly shown = computed(
    () =>
      this.modules.habits() &&
      (this.habits.toDo().length > 0 ||
        this.habits.settled().length > 0 ||
        !!this.habits.undoable()),
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

  protected when(h: PlacedHabit): string {
    return habitWhen(h);
  }
}
