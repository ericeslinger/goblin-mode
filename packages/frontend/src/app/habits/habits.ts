import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';
import { PageHeader } from '../home/page-header';
import { ModulesService } from '../modules/modules.service';
import { SignIn } from '../sign-in/sign-in';
import { HabitCard } from './habit-card';
import { HabitRefusals } from './habit-refusals';
import { HabitsService } from './habits.service';

/**
 * The Habits screen (`/habits`, #324 step 2): each habit with its week
 * strip, its streak and today's Done and Skip; + adds one (a name, a
 * time of day if any), daily and done-only in this step; Archived,
 * under them, keeps each archived habit's history in view, with
 * Unarchive. A write the server refused is said under the Undo line,
 * with Try again (2026-11-21). Streaks are read back as far as they
 * run while this screen is open. Off, it says where to switch the
 * module on; signed out, only sign-in.
 */
@Component({
  selector: 'app-habits',
  imports: [HabitCard, HabitRefusals, PageHeader, RouterLink, SignIn],
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
        @if (!modules.habits()) {
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
                Time of day <span class="hint">(optional)</span>
                <input type="time" name="time" [value]="time()" (input)="time.set(value($event))" />
              </label>
              <div class="actions">
                <button type="submit" class="primary" [disabled]="!name().trim()">Add</button>
                <button type="button" class="link" (click)="close()">Cancel</button>
              </div>
            </form>
          }
          <div role="status" class="status">
            @if (habits.undoable(); as last) {
              <span>{{ last.message }}</span>
              <button type="button" class="link" (click)="habits.undo()">Undo</button>
            }
          </div>
          <app-habit-refusals />
          @if (habits.loaded() && !habits.active().length && !adding()) {
            <div class="empty">
              <p>
                A habit is something you mean to do every day: a walk, a page of reading, the
                watering. Each day it waits in Right Now until you tick it done or skip it, and here
                you see its last seven days and how long it has kept going.
              </p>
              <button type="button" class="primary" (click)="adding.set(true)">
                Add your first habit
              </button>
            </div>
          }
          @if (habits.active().length) {
            <ul class="habits" aria-label="Habits">
              @for (h of habits.active(); track h.id) {
                <li><app-habit-card [habit]="h" /></li>
              }
            </ul>
          }
          @if (habits.archived().length) {
            <section aria-labelledby="habits-archived">
              <h2 id="habits-archived">Archived</h2>
              <ul class="habits" aria-labelledby="habits-archived">
                @for (h of habits.archived(); track h.id) {
                  <li><app-habit-card [habit]="h" [level]="3" /></li>
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
    .new input {
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

  constructor() {
    inject(DestroyRef).onDestroy(this.habits.showStreaks());
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected add(event: Event): void {
    event.preventDefault();
    if (!this.name().trim()) return;
    this.habits.add({ name: this.name(), time: this.time() || undefined });
    this.close();
  }

  protected close(): void {
    this.name.set('');
    this.time.set('');
    this.adding.set(false);
  }
}
