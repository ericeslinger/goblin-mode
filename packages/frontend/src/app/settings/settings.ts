import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  MEALS,
  MODULES,
  type Meal,
  WEEKDAYS,
  addDays,
  localDate,
  moodLine,
  weekdayOf,
} from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { AuthService } from '../auth.service';
import { buildInfo } from '../build-info';
import { CLAUDE_ACCESS_API } from '../claude/claude-access';
import { GroceryService } from '../kitchen/grocery.service';
import { NOW } from '../platform/platform';
import { type PushState, PushService } from '../push/push.service';
import { RemindersService } from '../reminders/reminders.service';
import { TemplatesService } from '../templates/templates.service';
import { ThemePicker } from '../theme/theme-picker';

/** The weekly reminder to plan the meals (#129). */
export const PLAN_REMINDER = 'Plan next week’s meals';

@Component({
  selector: 'app-settings',
  imports: [RouterLink, ThemePicker],
  template: `
    <main class="page">
      <a routerLink="/">Back</a>
      <h1>Settings</h1>
      @if (auth.user(); as user) {
        <p>Signed in as {{ user.email }}</p>
        <button type="button" (click)="signOut()">Sign out</button>
      } @else {
        <p>Not signed in.</p>
      }
      <h2>Appearance</h2>
      <app-theme-picker />
      @if (auth.user()) {
        <h2>Notifications</h2>
        <p role="status">{{ pushMessage[push.state()] }}</p>
        @if (push.state() === 'error') {
          <p class="error">{{ push.error() }}</p>
        }
        @switch (push.state()) {
          @case ('off') {
            <button type="button" (click)="push.enable()">Turn on notifications</button>
          }
          @case ('error') {
            <button type="button" (click)="push.enable()">Try again</button>
          }
          @case ('on') {
            <button type="button" (click)="push.disable()">Turn off notifications</button>
          }
        }
      }
      @if (auth.user()) {
        <h2 id="modules">Modules</h2>
        <p>
          Parts of Mossgoblin you can switch on or off. Off hides a module's screens; its notes stay
          as they are.
        </p>
        <ul aria-labelledby="modules" class="modules">
          @for (m of moduleList; track m.id) {
            <li>
              <label>
                <input
                  type="checkbox"
                  role="switch"
                  [checked]="modules.on(m.id)"
                  (change)="modules.set(m.id, $any($event.target).checked)"
                />
                {{ m.label }}
              </label>
              <span class="muted">{{ m.about }}</span>
            </li>
          }
        </ul>
        @if (modules.kitchen()) {
          <h2 id="kitchen">Kitchen</h2>
          <div class="kitchen">
            <label>
              Weeks start on
              <select #start (change)="modules.configureKitchen({ weekStart: $any(start.value) })">
                @for (d of weekdays; track d) {
                  <option [value]="d" [selected]="modules.kitchenConfig().weekStart === d">
                    {{ d }}
                  </option>
                }
              </select>
            </label>
            <fieldset>
              <legend>Meals to plan</legend>
              @for (m of meals; track m) {
                <label>
                  <input
                    type="checkbox"
                    [checked]="modules.kitchenConfig().meals.includes(m)"
                    (change)="toggleMeal(m, $any($event.target).checked)"
                  />
                  {{ m }}
                </label>
              }
            </fieldset>
            <label>
              Fish of the week on
              <select #fish (change)="modules.configureKitchen({ fishDay: $any(fish.value) })">
                @for (d of fishDays; track d.value) {
                  <option
                    [value]="d.value"
                    [selected]="modules.kitchenConfig().fishDay === d.value"
                  >
                    {{ d.label }}
                  </option>
                }
              </select>
            </label>
            <p class="muted">Changes apply to weeks not planned yet.</p>
            @if (planningReminder()) {
              <p>Each week you are reminded to plan: {{ planningReminder()!.text }}.</p>
            } @else {
              <button type="button" (click)="remindToPlan()">
                Remind me each week, the day before it starts, at 4 pm
              </button>
            }
            @if (grocery.listId(); as list) {
              <p>
                <a [routerLink]="['/n', list]">Grocery list</a>: planned dinners add their
                ingredients to it.
              </p>
            } @else {
              <button type="button" (click)="makeGroceryList()">Make the grocery list</button>
            }
            <a routerLink="/kitchen">This week’s meals</a>
          </div>
        }
        <h2 id="templates">Templates</h2>
        <p>
          A template is a note to start others from. Its Instructions for Claude, on the back of the
          note, tell Claude how to fill them in.
        </p>
        @if (templates.templates().length) {
          <ul aria-labelledby="templates" class="templates">
            @for (t of templates.templates(); track t.id) {
              <li>
                <a [routerLink]="['/n', t.id]">{{ t.title || 'Untitled' }}</a>
                <span class="muted">{{
                  t.templateMode === 'living' ? 'one note, reused' : 'a new note each time'
                }}</span>
              </li>
            }
          </ul>
        }
        <div class="actions">
          <button type="button" (click)="newTemplate('entry')">New template</button>
          <button type="button" (click)="newTemplate('living')">New living template</button>
          @if (!hasFeelingsJournal()) {
            <button type="button" (click)="newFeelingsJournal()">Add a feelings journal</button>
          }
        </div>
      }
      @if (auth.user()) {
        <h2>Claude</h2>
        <p>
          To let Claude read and change your notes, add a custom connector in claude.ai (Settings,
          Connectors) with this URL:
        </p>
        <p>
          <code>{{ mcpUrl }}</code>
        </p>
        <p>
          <a routerLink="/n/context">Context for Claude</a>: what Claude should always know about
          you and the garden, given to it at the start of every conversation.
        </p>
        <p><a routerLink="/activity">What Claude changed</a></p>
        <button type="button" (click)="disconnect()">Disconnect Claude</button>
        @if (claudeStatus()) {
          <p role="status">{{ claudeStatus() }}</p>
        }
      }
      <h2>Version</h2>
      <p>{{ build.sha }} &middot; {{ build.time }}</p>
    </main>
  `,
  styles: `
    .kitchen {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
    }
    .kitchen fieldset {
      display: flex;
      gap: var(--space-3);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
    }
    .modules {
      list-style: none;
      padding: 0;
    }
    .modules li {
      display: grid;
      gap: 2px;
      padding: var(--space-1) 0;
    }
    .modules label {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      min-height: 32px;
    }
    .templates {
      list-style: none;
      padding: 0;
    }
    .templates li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      padding: 2px 0;
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
  `,
})
export class Settings {
  protected readonly auth = inject(AuthService);
  protected readonly push = inject(PushService);
  protected readonly pushMessage: Record<PushState, string> = {
    checking: 'Checking…',
    unsupported: 'This browser cannot show notifications.',
    unconfigured: 'Notifications are not set up yet.',
    off: 'Reminders are not sent to this device.',
    blocked:
      'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.',
    on: 'Reminders are sent to this device.',
    working: 'One moment…',
    error: 'Could not change notifications.',
  };
  protected readonly build = buildInfo;

  protected readonly templates = inject(TemplatesService);
  protected readonly modules = inject(ModulesService);
  protected readonly moduleList = MODULES;
  private readonly router = inject(Router);

  protected readonly weekdays = WEEKDAYS;
  protected readonly meals = MEALS;
  protected readonly fishDays = [
    { value: 'Thu', label: 'Thursday' },
    { value: 'Fri', label: 'Friday' },
    { value: 'none', label: 'No fish' },
  ] as const;
  private readonly reminders = inject(RemindersService);
  private readonly now = inject(NOW);

  /** The weekly reminder to plan the meals, once made (#129). */
  protected readonly planningReminder = computed(() =>
    this.reminders
      .reminders()
      .find((r) => r.text === PLAN_REMINDER && r.status !== 'done' && !!r.recurrence),
  );

  protected toggleMeal(meal: Meal, on: boolean): void {
    const current = this.modules.kitchenConfig().meals;
    const meals = MEALS.filter((m) => (m === meal ? on : current.includes(m)));
    // At least one meal is planned; the last one stays.
    if (meals.length) this.modules.configureKitchen({ meals });
  }

  /** A weekly reminder at 4 pm the day before the week starts. */
  protected remindToPlan(): void {
    const before = WEEKDAYS[(WEEKDAYS.indexOf(this.modules.kitchenConfig().weekStart) + 6) % 7];
    let day = localDate(this.now());
    while (weekdayOf(day) !== before) day = addDays(day, 1);
    const [y, m, d] = day.split('-').map(Number);
    let dueAt = new Date(y, m - 1, d, 16).getTime();
    if (dueAt <= this.now()) dueAt = new Date(y, m - 1, d + 7, 16).getTime();
    this.reminders.add({ text: PLAN_REMINDER, dueAt, repeat: 'weekly' });
  }

  /** A template with a Moods line is a journal, whatever it is called (review on #96). */
  protected readonly hasFeelingsJournal = computed(() =>
    this.templates
      .templates()
      .some((t) => t.body.split('\n').some((line) => moodLine(line) !== undefined)),
  );

  /** The feelings journal template and its three reminders (#40), opened to look over. */
  protected newFeelingsJournal(): void {
    void this.router.navigate(['/n', this.templates.createFeelingsJournal()]);
  }

  protected readonly grocery = inject(GroceryService);

  /**
   * The grocery list, made from the Shopping list template, which now
   * lives in Kitchen (#130), and opened to look over.
   */
  protected makeGroceryList(): void {
    void this.router.navigate(['/n', this.grocery.makeList()]);
  }

  /** Makes a template and opens it to be written. */
  protected newTemplate(mode: 'living' | 'entry'): void {
    void this.router.navigate(['/n', this.templates.create(mode)]);
  }

  protected readonly mcpUrl = `${location.origin}/mcp`;
  protected readonly claudeStatus = signal('');
  private readonly claude = inject(CLAUDE_ACCESS_API);

  /** Drops every token Claude holds; claude.ai must connect again. */
  protected async disconnect(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      const n = await this.claude.revoke(await user.getIdToken());
      this.claudeStatus.set(n ? 'Claude is disconnected.' : 'Claude was not connected.');
    } catch (err) {
      this.claudeStatus.set(`Could not disconnect: ${(err as Error).message}`);
    }
  }

  protected async signOut(): Promise<void> {
    await this.push.beforeSignOut();
    await this.auth.signOut();
  }
}
