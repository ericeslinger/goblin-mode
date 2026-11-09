import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  isIsoDate,
  localDate,
  paths,
  planSlots,
  planStartFor,
  checklist,
} from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { inLens } from '../browse/lenses';
import { ACTIVITY_API } from '../claude/activity';
import { ProposalsService } from '../claude/proposals.service';
import { FIREBASE } from '../firebase';
import { GroceryService } from '../kitchen/grocery.service';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { ItemsService } from '../reader/items.service';
import { PODCASTS } from '../reader/shelves';
import { ReadingService } from '../reading/reading.service';
import { RemindersService } from '../reminders/reminders.service';
import { SignIn } from '../sign-in/sign-in';
import { Icon, type IconName } from './icon';

/** Right Now's row names at most this many reminders. */
export const HOME_REMINDERS = 2;

interface Tile {
  id: string;
  name: string;
  icon: IconName;
  link: string;
  status: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Home (#219, step 1 of #216, design A, Eric 2026-11-09): the box to
 * write in, Right Now's next few, and a tile for each place with a line
 * on how it stands. The box is a link to the capture note at `/`, so
 * writing is the launch screen's own flow, unchanged; nothing here
 * waits on auth or the network before it shows. A module that is off
 * has no tile. Signed out, only sign-in.
 */
@Component({
  selector: 'app-home',
  imports: [RouterLink, Icon, SignIn],
  template: `
    @if (auth.user() === null) {
      <app-sign-in />
    } @else {
      <div class="home">
        <header>
          <app-icon name="leaf" [size]="26" />
          <h1>Mossgoblin</h1>
          <span class="sync" role="status">
            <span class="dot" [class.offline]="!online()" aria-hidden="true"></span>
            {{ online() ? 'Synced' : 'Offline' }}
          </span>
          <a class="icon-link" routerLink="/settings" aria-label="Settings">
            <app-icon name="settings" [size]="22" />
          </a>
        </header>
        <main>
          <!-- A link, not a field: it never holds typing. The editor at /
               takes the cursor as it opens (autofocus). -->
          <a class="write card" routerLink="/">
            <app-icon name="write" [size]="20" />
            <span>Plant a thought</span>
          </a>
          <a class="right-now card" routerLink="/right-now">
            <app-icon name="right-now" />
            <span class="text">
              <span class="name">Right Now</span>
              <span class="status">{{ rightNow() }}</span>
            </span>
            <app-icon name="chevron" [size]="18" />
          </a>
          <nav aria-label="Modules">
            @for (t of tiles(); track t.id) {
              <a class="tile card" [routerLink]="t.link">
                <app-icon [name]="t.icon" [size]="28" />
                <span class="text">
                  <span class="name">{{ t.name }}</span>
                  <span class="status">{{ t.status }}</span>
                </span>
              </a>
            }
          </nav>
          <p class="hint">Tap the box to write; it opens the editor.</p>
        </main>
      </div>
    }
  `,
  styles: `
    .home {
      max-width: 640px;
      margin: 0 auto;
      padding: 0 var(--space-3) var(--space-3);
    }
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: var(--space-3) 0 var(--space-2);
    }
    h1 {
      flex: 1;
      margin: 0;
      font-size: 20px;
    }
    .sync {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--quiet);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--good);
    }
    .dot.offline {
      background: var(--warn);
    }
    .icon-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: var(--radius-control);
    }
    main {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    a {
      color: var(--ink);
      text-decoration: none;
    }
    .card {
      box-sizing: border-box;
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
    }
    .write {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 52px;
      padding: 0 14px;
      font-size: 17px;
      color: var(--quiet);
      cursor: text;
    }
    .right-now {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
    }
    .text {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .name {
      font-size: 16px;
      font-weight: 600;
    }
    .status {
      font-size: 14px;
      color: var(--quiet);
    }
    nav {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .tile {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 108px;
      padding: 14px;
    }
    .tile .status {
      font-size: 13px;
    }
    .hint {
      margin: var(--space-2) 0 0;
      font-size: 13px;
      color: var(--quiet);
      text-align: center;
    }
  `,
})
export class Home {
  protected readonly auth = inject(AuthService);
  private readonly notes = inject(NotesService);
  private readonly modules = inject(ModulesService);
  private readonly reminders = inject(RemindersService);
  private readonly items = inject(ItemsService);
  private readonly reading = inject(ReadingService);
  private readonly proposals = inject(ProposalsService);
  private readonly grocery = inject(GroceryService);
  private readonly activity = inject(ACTIVITY_API);
  private readonly fb = inject(FIREBASE);
  private readonly now = inject(NOW);
  protected readonly online = signal(navigator.onLine);
  /** When the assistants' latest runs were, in milliseconds. */
  private readonly runs = signal<number[]>([]);

  /** The next reminder or two, then what is new in the Reader, as Right Now has them. */
  protected readonly rightNow = computed(() => {
    const parts = this.reminders
      .placed()
      .slice(0, HOME_REMINDERS)
      .map((r) => r.text);
    const fresh = this.modules.reader()
      ? this.items.newSince().reduce((sum, f) => sum + f.count, 0)
      : 0;
    if (fresh) parts.push(`${fresh} new in the Reader`);
    return parts.length ? parts.join(' · ') : 'Nothing to tend. The garden is quiet.';
  });

  /** The tiles, in a fixed order for now (#216 step 2 makes them movable). */
  protected readonly tiles = computed<Tile[]>(() => {
    const tiles: Tile[] = [
      { id: 'notes', name: 'Notes', icon: 'notes', link: '/browse', status: this.notesLine() },
    ];
    if (this.modules.kitchen()) {
      tiles.push({
        id: 'kitchen',
        name: 'Kitchen',
        icon: 'kitchen',
        link: '/kitchen',
        status: this.kitchenLine(),
      });
    }
    if (this.modules.reader()) {
      const counts = this.items.unreadCounts();
      const episodes = counts[PODCASTS] ?? 0;
      tiles.push({
        id: 'reader',
        name: 'Reader',
        icon: 'reader',
        link: '/reader',
        status: [
          `${counts['all'] ?? 0} unread`,
          ...(episodes ? [plural(episodes, 'episode', 'episodes')] : []),
        ].join(' · '),
      });
    }
    const toRead = this.reading.unread().length;
    const today = this.startOfToday();
    const runsToday = this.runs().filter((at) => at >= today).length;
    tiles.push(
      {
        id: 'reading',
        name: 'Reading queue',
        icon: 'reading',
        link: '/reading',
        status: toRead ? `${toRead} to read` : 'Nothing waiting',
      },
      {
        id: 'assistants',
        name: 'Assistants',
        icon: 'assistants',
        link: '/activity',
        status: [
          plural(this.proposals.open(), 'suggestion', 'suggestions'),
          ...(runsToday ? [`${plural(runsToday, 'run', 'runs')} today`] : []),
        ].join(' · '),
      },
      { id: 'map', name: 'Map', icon: 'map', link: '/map', status: 'The whole garden' },
    );
    return tiles;
  });

  constructor() {
    // The runs, as What assistants changed lists them, for how many today.
    let stop: (() => void) | undefined;
    effect(() => {
      const uid = this.auth.user()?.uid;
      stop?.();
      stop = undefined;
      this.runs.set([]);
      if (!uid) return;
      stop = this.activity.listen(
        this.fb.db,
        paths.activity(uid),
        (docs) =>
          this.runs.set(
            docs
              .map((d) => (d.data['at'] as { toMillis?: () => number } | undefined)?.toMillis?.())
              .filter((at): at is number => at !== undefined),
          ),
        (err) => console.error('activity listener', err),
      );
    });
    const update = () => this.online.set(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      stop?.();
      removeEventListener('online', update);
      removeEventListener('offline', update);
    });
  }

  /** Every note Browse's Recent lists, and how many were written in today. */
  private notesLine(): string {
    const live = this.notes.notes().filter((n) => inLens('recent', n));
    const today = this.startOfToday();
    const edited = live.filter((n) => (n.updatedAt ?? 0) >= today).length;
    return `${live.length} · ${edited} today`;
  }

  /** Tonight's dinner from this week's plan, and what the grocery list has open. */
  private kitchenLine(): string {
    const date = localDate(this.now());
    const plans = this.notes
      .notes()
      .filter((n) => n.kind === 'mealplan' && !n.archived && n.periodStart);
    const start = planStartFor(
      date,
      this.modules.kitchenConfig().weekStart,
      plans.map((n) => n.periodStart!).filter(isIsoDate),
    );
    const plan = plans.find((n) => n.periodStart === start);
    const slot = plan
      ? planSlots(plan.body, start).find((s) => s.date === date && s.meal === 'dinner')
      : undefined;
    const dinner = !slot?.text
      ? 'nothing planned'
      : slot.kind === 'recipe'
        ? (slot.recipe ?? slot.text)
        : slot.text;
    const parts = [`Tonight: ${dinner}`];
    const listId = this.grocery.listId();
    const list = listId ? this.notes.find(listId) : undefined;
    if (list) {
      const open = checklist(list.body).reduce(
        (sum, s) => sum + s.items.filter((i) => !i.done).length,
        0,
      );
      parts.push(`${open} to buy`);
    }
    return parts.join(' · ');
  }

  private startOfToday(): number {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}
