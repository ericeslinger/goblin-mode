import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import {
  MEALS,
  MODULES,
  type Meal,
  PROVIDERS,
  PROVIDER_INFO,
  type Provider,
  QUEUE_PROMPT,
  type StartOn,
  WEEKDAYS,
  addDays,
  localDate,
  moodLine,
  weekdayOf,
} from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { StartOnService } from '../home/start-on';
import { AuthService } from '../auth.service';
import { buildInfo } from '../build-info';
import { CLAUDE_ACCESS_API } from '../claude/claude-access';
import { KeysService } from '../keys/keys.service';
import { GroceryService } from '../kitchen/grocery.service';
import { CAP_CHOICES, DownloadPrefs } from '../reader/download-prefs';
import { ReaderService } from '../reader/reader.service';
import { NOW } from '../platform/platform';
import { type PushState, PushService } from '../push/push.service';
import { RemindersService } from '../reminders/reminders.service';
import { TemplatesService } from '../templates/templates.service';
import { ThemePicker } from '../theme/theme-picker';
import { reloadPage } from '../unknown-route';
import { HomeLink } from '../home/home-link';

/** The weekly reminder to plan the meals (#129). */
export const PLAN_REMINDER = 'Plan next week’s meals';

@Component({
  selector: 'app-settings',
  imports: [HomeLink, RouterLink, ThemePicker],
  template: `
    <main class="page">
      <app-home-link />
      <h1>Settings</h1>
      @if (auth.user(); as user) {
        <p>Signed in as {{ user.email }}</p>
        <button type="button" (click)="signOut()">Sign out</button>
      } @else {
        <p>Not signed in.</p>
      }
      <h2 id="start-on">Start on</h2>
      <p class="muted">
        The screen the app opens on. Home is one tap away from everywhere either way.
      </p>
      <div role="radiogroup" aria-labelledby="start-on" class="start-on">
        @for (c of startChoices; track c.value) {
          <label>
            <input
              type="radio"
              name="start-on"
              [value]="c.value"
              [checked]="startOn.choice() === c.value"
              (change)="startOn.set(c.value)"
            />
            <span>
              {{ c.label }}
              <span class="muted">{{ startNote(c.value) ?? c.about }}</span>
            </span>
          </label>
        }
      </div>
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
        @if (modules.reader()) {
          <h2 id="reader">Reader</h2>
          <div class="kitchen">
            <label>
              <input
                type="checkbox"
                role="switch"
                [checked]="readerSettings.images()"
                (change)="readerSettings.setImages($any($event.target).checked)"
              />
              Show images in articles
            </label>
            <label>
              <input
                type="checkbox"
                role="switch"
                [checked]="readerSettings.readOnScroll()"
                (change)="readerSettings.setReadOnScroll($any($event.target).checked)"
              />
              Mark articles read as I scroll past them
            </label>
            <label>
              Keep articles for
              <select #keep (change)="keepArticles(keep.value)" [disabled]="tidying()">
                <option value="" [selected]="!readerSettings.keepMonths()">
                  as long as I like
                </option>
                @for (m of keepChoices; track m) {
                  <option [value]="m" [selected]="readerSettings.keepMonths() === m">
                    {{ m }} months
                  </option>
                }
              </select>
            </label>
            <p class="muted">
              Saved and filed articles are always kept; unsaved ones go after that long.
            </p>
            <button type="button" [disabled]="tidying()" (click)="sweepArticles()">
              Remove unread articles older than three months
            </button>
            @if (retentionStatus()) {
              <p role="status">{{ retentionStatus() }}</p>
            }
            <button type="button" [disabled]="indexing()" (click)="indexArticles()">
              Index articles for search
            </button>
            <p class="muted">
              New articles are indexed as they arrive; this indexes the ones stored before, once a
              day.
            </p>
            @if (indexStatus()) {
              <p role="status">{{ indexStatus() }}</p>
            }
            <p class="muted">
              <a routerLink="/reader">Reader</a> · <a routerLink="/reader/feeds">Manage feeds</a>
            </p>
          </div>
        }
        @if (modules.reader() || modules.podcasts()) {
          <!-- An episode's downloads (#180), the Reader's and Podcasts' alike (#245). -->
          <h2 id="downloads">Downloads</h2>
          <div class="kitchen">
            <label>
              Keep up to
              <select
                #cap
                aria-label="Downloaded episodes kept on this device, at most"
                (change)="downloadPrefs.setCap(+cap.value)"
              >
                @for (mb of capChoices; track mb) {
                  <option [value]="mb" [selected]="downloadPrefs.capMb() === mb">
                    {{ mb >= 1000 ? mb / 1000 + ' GB' : mb + ' MB' }}
                  </option>
                }
              </select>
              of episodes on this device
            </label>
            <label>
              <input
                type="checkbox"
                role="switch"
                [checked]="downloadPrefs.wifiOnly()"
                (change)="downloadPrefs.setWifiOnly($any($event.target).checked)"
              />
              Download new episodes on their own only on Wi-Fi
            </label>
            <p class="muted">
              Where the browser says what the connection is; a tap on Download works on any
              connection. These are this device's; a show's newest are kept downloaded from its page
              in Podcasts.
            </p>
            <p class="muted">
              @if (modules.podcasts()) {
                <a routerLink="/podcasts">Podcasts</a> ·
              }
              <a routerLink="/reader/downloads">Downloads</a>
            </p>
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
        <h2>AI assistants</h2>
        <p>
          To let Claude read and change your notes, add a custom connector in claude.ai (Settings,
          Connectors) with this URL:
        </p>
        <p>
          <code>{{ mcpUrl }}</code>
        </p>
        <p>
          For Gemini CLI, or another app that takes an MCP server, add it to that app's settings;
          for Gemini CLI, in <code>~/.gemini/settings.json</code>:
        </p>
        <pre><code>{{ geminiSettings }}</code></pre>
        <p>then run <code>/mcp auth mossgoblin</code> in it and allow it here.</p>
        <p>
          <a routerLink="/n/context">Context for Claude</a>: what Claude should always know about
          you and the garden, given to it at the start of every conversation.
        </p>
        <h3>Your API keys</h3>
        <p>
          Transcriptions and the assistant's on-demand work run on your own account; transcriptions
          use your Anthropic key. Make a key just for Mossgoblin, with a spending limit, so it can
          be capped and revoked on its own. It is checked with the provider, stored encrypted, and
          never shown again.
        </p>
        @if (keys.keys(); as kept) {
          <ul class="keys" aria-label="API keys">
            @for (p of providers; track p) {
              <li>
                <span class="provider">{{ providerName[p] }}</span>
                @if (kept[p]; as key) {
                  <span class="muted">
                    <code>{{ key.masked }}</code>
                    @if (key.broken) {
                      , not accepted any more
                    } @else if (key.updatedAt !== undefined) {
                      , added {{ keyDate(key.updatedAt) }}
                    }
                    @if (!key.broken && key.lastUsedAt !== undefined) {
                      , last used {{ keyDate(key.lastUsedAt) }}
                    }
                  </span>
                  <button type="button" [disabled]="keyBusy()" (click)="removeKey(p)">
                    Remove
                  </button>
                } @else {
                  <form class="key-form" (submit)="saveKey($event, p, keyInput)">
                    <input
                      #keyInput
                      type="password"
                      autocomplete="off"
                      [attr.aria-label]="providerName[p] + ' key'"
                      [placeholder]="'Starts with ' + providerPrefix[p]"
                    />
                    <button type="submit" [disabled]="keyBusy()">Save</button>
                  </form>
                }
              </li>
            }
          </ul>
        } @else {
          <p class="muted">Loading…</p>
        }
        @if (keyStatus()) {
          <p role="status">{{ keyStatus() }}</p>
        }
        <h3>Ask it to look something up</h3>
        <p>
          End a checklist item with <code>&#64;goblin</code>, like “research good presents for my
          nephews &#64;goblin”, and once you leave the note your assistant looks it up on the web,
          writes what it found under the item, and ticks it. It needs your Anthropic key, and the
          item’s words are the only instruction it takes.
        </p>
        <h3>Send to an assistant</h3>
        <p>
          A note you send (on its back, Send to an assistant) waits until your assistant checks. For
          Claude, make a routine in Claude Code on the web that runs every hour with the Mossgoblin
          connector, and give it this prompt; any assistant that runs on a schedule can use it too.
        </p>
        <pre class="prompt"><code>{{ queuePrompt }}</code></pre>
        @if (keys.keys()?.anthropic) {
          <h3>Garden on arrival</h3>
          <label>
            <input
              type="checkbox"
              role="switch"
              [checked]="keys.onArrival()"
              (change)="keys.setOnArrival($any($event.target).checked)"
            />
            Garden new notes on arrival
          </label>
          <p class="muted">
            Once you leave a new note, it is sent to the garden’s own assistant with no ask and done
            at once on your Anthropic key: filed, linked and tagged, your words kept as they are.
            Only plain notes you wrote; it counts in the day’s runs.
          </p>
          <h3 id="arrival-skip">Never gardened on arrival</h3>
          <p class="muted">
            Templates, recipes, concepts, meal plans, the pantry, the context note and clippings are
            never sent on arrival, nor is a note whose back says Leave this note alone.
          </p>
          @if (templates.templates().length) {
            <ul aria-labelledby="arrival-skip" class="skip-templates">
              @for (t of templates.templates(); track t.id) {
                <li>
                  <label>
                    <input
                      type="checkbox"
                      [checked]="keys.arrivalSkip().templates.includes(t.id)"
                      (change)="skipTemplate(t.id, $any($event.target).checked)"
                    />
                    Notes made from {{ t.title || 'Untitled' }}
                  </label>
                </li>
              }
            </ul>
          }
          <label class="skip-tags">
            Notes with these tags (comma separated)
            <input
              #skipTags
              type="text"
              placeholder="private, journal"
              [value]="keys.arrivalSkip().tags.join(', ')"
              (change)="skipTagsTo(skipTags.value)"
            />
          </label>
        }
        <h3 id="digest-push">Daily digest</h3>
        <p class="muted">
          What assistants changed starts with yesterday in one line. It can come by push too, once a
          day at the hour you pick, only when something changed; it needs notifications on.
        </p>
        <div class="digest-push">
          <label>
            <input
              type="checkbox"
              role="switch"
              [checked]="keys.digest().push"
              (change)="keys.setDigestPush($any($event.target).checked)"
            />
            A daily digest by push
          </label>
          <label>
            at
            <select
              aria-label="Hour of the daily digest"
              (change)="keys.setDigestHour(+$any($event.target).value)"
            >
              @for (h of hours; track h) {
                <option [value]="h" [selected]="h === keys.digest().hour">{{ hourName(h) }}</option>
              }
            </select>
          </label>
        </div>
        <p><a routerLink="/activity">What assistants changed</a></p>
        <button type="button" (click)="disconnect()">Disconnect all assistants</button>
        @if (claudeStatus()) {
          <p role="status">{{ claudeStatus() }}</p>
        }
      }
      <h2>Version</h2>
      <p class="version">
        <span>{{ build.sha }} &middot; {{ build.time }}</span>
        <button type="button" [disabled]="checking()" (click)="checkForUpdate()">
          {{ checking() ? 'Checking…' : 'Check for updates' }}
        </button>
      </p>
      @if (updateStatus()) {
        <p role="status">{{ updateStatus() }}</p>
      }
    </main>
  `,
  styles: `
    .start-on label {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 44px;
      margin: 0;
    }
    .start-on label > span {
      display: flex;
      flex-direction: column;
    }
    .start-on .muted {
      font-size: 13px;
    }
    .keys {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: var(--space-2);
    }
    .keys li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .provider {
      min-width: 6em;
      font-weight: 600;
    }
    .key-form {
      display: flex;
      flex: 1;
      gap: var(--space-2);
    }
    .key-form input {
      flex: 1;
      min-width: 8em;
    }
    /* A snippet wraps: unwrapped, the Gemini setting made the whole
       page wider than a phone (#246). */
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .version {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
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
    .skip-templates {
      list-style: none;
      padding: 0;
    }
    .digest-push {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }
    .digest-push label {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      min-height: 44px;
    }
    .skip-tags {
      display: grid;
      gap: var(--space-1);
      max-width: 24em;
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
  private readonly updates = inject(SwUpdate, { optional: true });
  protected readonly checking = signal(false);
  protected readonly updateStatus = signal('');

  /**
   * Check for updates (Eric, 2026-11-07): the installed app serves the
   * version it cached until the worker has looked for a newer one, so
   * this asks it to look now and reloads into what it finds, instead of
   * refreshing and hoping.
   */
  protected async checkForUpdate(): Promise<void> {
    if (!this.updates?.isEnabled) {
      this.updateStatus.set('Updates are not managed here (a dev server): reload the page.');
      return;
    }
    this.checking.set(true);
    this.updateStatus.set('Looking for a newer version…');
    try {
      if (await this.updates.checkForUpdate()) {
        this.updateStatus.set('A newer version is ready; reloading into it.');
        await this.updates.activateUpdate();
        reloadPage.run();
        return;
      }
      this.updateStatus.set(`You have the latest version (${this.build.sha}).`);
    } catch (err) {
      console.error('update check', err);
      this.updateStatus.set('Could not check for updates. Are you online?');
    } finally {
      this.checking.set(false);
    }
  }

  protected readonly templates = inject(TemplatesService);
  protected readonly modules = inject(ModulesService);
  protected readonly readerSettings = inject(ReaderService);
  protected readonly keepChoices = [3, 6, 12];
  /** Downloaded episodes (#180): the cap and Wi-Fi, this device's. */
  protected readonly downloadPrefs = inject(DownloadPrefs);
  protected readonly capChoices = CAP_CHOICES;
  protected readonly tidying = signal(false);
  protected readonly retentionStatus = signal('');

  /** Keep articles for (#171): the setting, then applied to what is stored. */
  protected async keepArticles(value: string): Promise<void> {
    this.tidying.set(true);
    try {
      this.retentionStatus.set(
        await this.readerSettings.setKeepMonths(value ? Number(value) : undefined),
      );
    } finally {
      this.tidying.set(false);
    }
  }

  protected readonly indexing = signal(false);
  protected readonly indexStatus = signal('');

  /** Index articles for search (#175): the word index on the articles stored before it. */
  protected async indexArticles(): Promise<void> {
    this.indexing.set(true);
    this.indexStatus.set('');
    try {
      this.indexStatus.set(await this.readerSettings.indexArticles());
    } finally {
      this.indexing.set(false);
    }
  }

  /** The sweep (#171): old unread, unsaved, unfiled articles removed now. */
  protected async sweepArticles(): Promise<void> {
    this.tidying.set(true);
    try {
      this.retentionStatus.set(await this.readerSettings.sweep());
    } finally {
      this.tidying.set(false);
    }
  }
  protected readonly moduleList = MODULES;
  protected readonly startOn = inject(StartOnService);
  /** Start on's choices (#219), as the Settings sketch words them. */
  protected readonly startChoices: { value: StartOn; label: string; about: string }[] = [
    { value: 'home', label: 'Home', about: 'Capture, Right Now and the modules' },
    { value: 'note', label: 'A new note', about: 'As before: the editor, ready to type' },
    { value: 'right-now', label: 'Right Now', about: 'Reminders and what is new' },
    { value: 'kitchen', label: 'Kitchen', about: 'This week’s meals' },
    { value: 'reader', label: 'Reader', about: 'Unread articles' },
    { value: 'podcasts', label: 'Podcasts', about: 'The newest episodes' },
  ];

  /** A module's choice while it is off: it opens Home instead. */
  protected startNote(choice: StartOn): string | undefined {
    if (choice === 'kitchen' && !this.modules.kitchen())
      return 'Kitchen is off, so this opens Home';
    if (choice === 'reader' && !this.modules.reader()) return 'Reader is off, so this opens Home';
    if (choice === 'podcasts' && !this.modules.podcasts())
      return 'Podcasts is off, so this opens Home';
    return undefined;
  }
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
  /** The prompt for the routine that works through sent notes (#143). */
  protected readonly queuePrompt = QUEUE_PROMPT;
  /** Gemini CLI's MCP setting for the garden (#142). */
  protected readonly geminiSettings = JSON.stringify(
    { mcpServers: { mossgoblin: { httpUrl: this.mcpUrl } } },
    null,
    2,
  );
  protected readonly claudeStatus = signal('');

  /** The gardener's own provider keys (#144). */
  protected readonly keys = inject(KeysService);
  protected readonly providers = PROVIDERS;
  /** The hours the daily digest can come at (#237). */
  protected readonly hours = Array.from({ length: 24 }, (_, h) => h);
  private readonly hourFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

  /** An hour on this device's clock, as it writes them: "8 AM", or "08". */
  protected hourName(h: number): string {
    return this.hourFormat.format(new Date(2026, 0, 1, h));
  }
  protected readonly providerName = Object.fromEntries(
    PROVIDERS.map((p) => [p, PROVIDER_INFO[p].name]),
  ) as Record<Provider, string>;
  protected readonly providerPrefix = Object.fromEntries(
    PROVIDERS.map((p) => [p, PROVIDER_INFO[p].prefix]),
  ) as Record<Provider, string>;
  protected readonly keyStatus = signal('');
  protected readonly keyBusy = signal(false);

  /** Notes made from this template are never gardened on arrival, or are again (#229). */
  protected skipTemplate(id: string, skip: boolean): void {
    const now = this.keys.arrivalSkip();
    const templates = now.templates.filter((t) => t !== id);
    this.keys.setArrivalSkip({ ...now, templates: skip ? [...templates, id] : templates });
  }

  /** Notes with these tags are never gardened on arrival (#229). */
  protected skipTagsTo(value: string): void {
    this.keys.setArrivalSkip({
      ...this.keys.arrivalSkip(),
      tags: value.split(',').map((t) => t.trim()),
    });
  }

  protected keyDate(ms: number): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(ms);
  }

  /** Sends a pasted key to be checked and kept; the field is cleared either way. */
  protected async saveKey(
    event: Event,
    provider: Provider,
    input: HTMLInputElement,
  ): Promise<void> {
    event.preventDefault();
    const key = input.value;
    input.value = '';
    if (!key.trim()) return;
    this.keyBusy.set(true);
    this.keyStatus.set('Checking the key…');
    try {
      const { masked } = await this.keys.save(provider, key);
      this.keyStatus.set(`${this.providerName[provider]} key ${masked} saved.`);
    } catch (err) {
      this.keyStatus.set(`Could not save the key: ${(err as Error).message}`);
    } finally {
      this.keyBusy.set(false);
    }
  }

  protected async removeKey(provider: Provider): Promise<void> {
    this.keyBusy.set(true);
    try {
      await this.keys.remove(provider);
      this.keyStatus.set(
        `${this.providerName[provider]} key removed here; revoke it at ${this.providerName[provider]} too.`,
      );
    } catch (err) {
      this.keyStatus.set(`Could not remove the key: ${(err as Error).message}`);
    } finally {
      this.keyBusy.set(false);
    }
  }
  private readonly claude = inject(CLAUDE_ACCESS_API);

  /** Drops every token any assistant holds; each must connect again. */
  protected async disconnect(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      const n = await this.claude.revoke(await user.getIdToken());
      this.claudeStatus.set(n ? 'Every assistant is disconnected.' : 'No assistant was connected.');
    } catch (err) {
      this.claudeStatus.set(`Could not disconnect: ${(err as Error).message}`);
    }
  }

  protected async signOut(): Promise<void> {
    await this.push.beforeSignOut();
    await this.auth.signOut();
  }
}
