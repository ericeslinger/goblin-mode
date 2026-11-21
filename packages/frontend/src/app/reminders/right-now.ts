import { Component, computed, inject, signal } from '@angular/core';
import { SECTIONS } from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { HabitsService } from '../habits/habits.service';
import { RightNowHabits } from '../habits/right-now-habits';
import { ModulesService } from '../modules/modules.service';
import { PodcastsNew } from '../podcasts/podcasts-new';
import { ReaderNew } from '../reader/reader-new';
import { SignIn } from '../sign-in/sign-in';
import { AddReminder } from './add-reminder';
import { ReminderRow } from './reminder-row';
import { type PlacedReminder, RemindersService } from './reminders.service';
import { UndoBar } from './undo-bar';
import { PageHeader } from '../home/page-header';

/**
 * Right Now, full screen: every open reminder by section, Overdue
 * tinted, and +; then what is new in the Reader (#173), a line per
 * folder, and in Podcasts (#251), under the reminders since #288.
 * With Habits on (#324), today's habits after what is overdue or due
 * today and before what comes later: they are today's too. Signed
 * out, only sign-in.
 */
@Component({
  selector: 'app-right-now',
  imports: [
    PageHeader,
    AddReminder,
    PodcastsNew,
    ReaderNew,
    ReminderRow,
    RightNowHabits,
    SignIn,
    UndoBar,
  ],
  template: `
    @if (auth.user() === null) {
      <app-sign-in />
    } @else {
      <main class="page">
        <app-page-header title="Right Now">
          @if (!adding()) {
            <button
              type="button"
              class="add"
              aria-label="Add a reminder"
              (click)="adding.set(true)"
            >
              +
            </button>
          }
        </app-page-header>
        @if (adding()) {
          <app-add-reminder (closed)="adding.set(false)" />
        }
        <app-undo-bar />
        @for (s of sections(); track s.id) {
          @if (s.items) {
            <section [attr.aria-labelledby]="'section-' + s.id">
              <h2 [id]="'section-' + s.id" [class.overdue]="s.id === 'overdue'">{{ s.label }}</h2>
              <ul [attr.aria-labelledby]="'section-' + s.id">
                @for (r of s.items; track r.id) {
                  <li><app-reminder-row [reminder]="r" /></li>
                }
              </ul>
            </section>
          } @else {
            <!-- Habits (#324): today's, so after Overdue and Today. -->
            <app-right-now-habits />
          }
        }
        @if (quiet()) {
          <p class="muted">Nothing to tend. The garden is quiet.</p>
        }
        <!-- Under the reminders (#288): a line per folder, here only. -->
        <app-reader-new />
        <app-podcasts-new />
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
    /* 44 px on a touch screen, said here rather than grown by the
       base min-width (2026-11-15). */
    @media (pointer: coarse) {
      .add {
        width: 44px;
        height: 44px;
      }
    }
    h2 {
      margin: 20px 0 4px;
      font-size: 15px;
      color: var(--quiet);
    }
    /* Overdue in the accent, a text colour held to AA on the page, and
       a bar beside it: the word says it too, not the colour alone. */
    h2.overdue {
      padding-left: 8px;
      border-left: 3px solid var(--accent);
      color: var(--accent);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .muted {
      color: var(--quiet);
    }
  `,
})
export class RightNow {
  protected readonly auth = inject(AuthService);
  private readonly reminders = inject(RemindersService);
  private readonly habits = inject(HabitsService);
  private readonly modules = inject(ModulesService);
  protected readonly adding = signal(false);

  /**
   * Only sections with something in them, and the habits' place among
   * them (an entry with no items): after what is overdue or due today,
   * before what comes later.
   */
  protected readonly sections = computed(() => {
    const placed = this.reminders.placed();
    const all: { id: string; label: string; items?: PlacedReminder[] }[] = SECTIONS.map((s) => ({
      ...s,
      items: placed.filter((r) => r.section === s.id),
    })).filter((s) => s.items.length > 0);
    const later = all.findIndex((s) => s.id !== 'overdue' && s.id !== 'today');
    all.splice(later < 0 ? all.length : later, 0, { id: 'habits', label: 'Habits' });
    return all;
  });

  /** No reminder, and no habit due today. */
  protected readonly quiet = computed(
    () =>
      this.reminders.placed().length === 0 &&
      !(this.modules.habits() && this.habits.placed().some((h) => h.due)),
  );
}
