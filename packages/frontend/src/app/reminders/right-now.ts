import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SECTIONS } from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { SignIn } from '../sign-in/sign-in';
import { AddReminder } from './add-reminder';
import { ReminderRow } from './reminder-row';
import { RemindersService } from './reminders.service';
import { UndoBar } from './undo-bar';

/** Right Now, full screen: every open reminder by section, and +. Signed out, only sign-in. */
@Component({
  selector: 'app-right-now',
  imports: [RouterLink, AddReminder, ReminderRow, SignIn, UndoBar],
  template: `
    @if (auth.user() === null) {
      <app-sign-in />
    } @else {
      <main class="page">
        <div class="top">
          <a routerLink="/">Back</a>
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
        </div>
        <h1>Right Now</h1>
        @if (adding()) {
          <app-add-reminder (closed)="adding.set(false)" />
        }
        <app-undo-bar />
        @for (s of sections(); track s.id) {
          <section [attr.aria-labelledby]="'section-' + s.id">
            <h2 [id]="'section-' + s.id">{{ s.label }}</h2>
            <ul [attr.aria-labelledby]="'section-' + s.id">
              @for (r of s.items; track r.id) {
                <li><app-reminder-row [reminder]="r" /></li>
              }
            </ul>
          </section>
        } @empty {
          <p class="muted">Nothing to do.</p>
        }
      </main>
    }
  `,
  styles: `
    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .add {
      font: inherit;
      font-size: 22px;
      line-height: 1;
      width: 40px;
      height: 40px;
      border: 0;
      border-radius: 50%;
      color: var(--on-accent);
      background: var(--accent);
      cursor: pointer;
    }
    h2 {
      margin: 20px 0 4px;
      font-size: 15px;
      color: var(--quiet);
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
  protected readonly adding = signal(false);

  /** Only sections with something in them. */
  protected readonly sections = computed(() => {
    const placed = this.reminders.placed();
    return SECTIONS.map((s) => ({ ...s, items: placed.filter((r) => r.section === s.id) })).filter(
      (s) => s.items.length > 0,
    );
  });
}
