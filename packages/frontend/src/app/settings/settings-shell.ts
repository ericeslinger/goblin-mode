import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { MODULES } from '@mossgoblin/schema';
import { filter, map } from 'rxjs';
import { AuthService } from '../auth.service';
import { buildInfo } from '../build-info';
import { PageHeader } from '../home/page-header';
import { StartOnService } from '../home/start-on';
import { ModulesService } from '../modules/modules.service';
import { type PushState, PushService } from '../push/push.service';
import { TemplatesService } from '../templates/templates.service';
import { ThemeService } from '../theme/theme.service';
import { themeById } from '../theme/themes';
import { SETTINGS_PAGES, START_CHOICES, type SettingsPageId, pageName } from './settings-pages';

/** The page a Settings URL shows, or undefined for the list. */
export function pageOf(url: string): SettingsPageId | undefined {
  const id = /^\/settings\/([^/?#]+)/.exec(url)?.[1];
  return SETTINGS_PAGES.find((p) => p.id === id)?.id;
}

/**
 * Settings as pages (#290, 2026-11-16). One header for the screen:
 * "Settings" over the list, a page's name and "‹ Settings" over a
 * page. Under 900 px the list is one screen and a page another; from
 * 900 px the list is a column and the page shows beside it, the first
 * page at `/settings`. Which shows is CSS on the route alone.
 */
@Component({
  selector: 'app-settings-shell',
  imports: [PageHeader, RouterLink, RouterOutlet],
  template: `
    <main class="page settings" [class.on-page]="!!current()">
      <app-page-header
        [title]="current() ? name(current()!) : 'Settings'"
        [backLabel]="current() ? 'Settings' : undefined"
        backLink="/settings"
      />
      <div class="columns">
        <nav class="rows" aria-label="Settings">
          <ul>
            @for (p of pages; track p.id) {
              <li>
                <a
                  [routerLink]="['/settings', p.id]"
                  [attr.aria-current]="current() === p.id ? 'page' : null"
                  [attr.aria-label]="p.name"
                  [attr.aria-describedby]="state()[p.id] ? 'settings-row-' + p.id : null"
                >
                  <span class="name">{{ p.name }}</span>
                  @if (state()[p.id]; as line) {
                    <span class="state" [id]="'settings-row-' + p.id">{{ line }}</span>
                  }
                </a>
              </li>
            }
          </ul>
        </nav>
        <div class="shown">
          <router-outlet />
        </div>
      </div>
    </main>
  `,
  styles: `
    .settings {
      max-width: 640px;
    }
    .rows ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .rows li {
      border-bottom: var(--border) solid var(--rule);
    }
    .rows a {
      /* Block-level name and line: they read as two phrases, never run
         together, and the whole row is the tap. */
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-height: 44px;
      padding: var(--space-2) var(--space-1);
      color: var(--ink);
      text-decoration: none;
      border-radius: var(--radius-control);
    }
    .rows a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .rows .name {
      font-weight: 600;
    }
    .rows .state {
      color: var(--quiet);
      font-size: 14px;
    }
    .rows a[aria-current='page'] {
      background: var(--surface);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    /* A phone: the list, or a page, never both. */
    .on-page .rows,
    .settings:not(.on-page) .shown {
      display: none;
    }
    @media (min-width: 900px) {
      .settings {
        max-width: 1040px;
      }
      .columns {
        display: grid;
        grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
        gap: var(--space-4, 24px);
        align-items: start;
      }
      .on-page .rows,
      .settings:not(.on-page) .shown {
        display: block;
      }
      /* The list is beside the page: no way back is needed. */
      :host ::ng-deep app-page-header .back {
        display: none;
      }
      /* At /settings the first page shows; its row says so by look. */
      .settings:not(.on-page) .rows li:first-child a {
        background: var(--surface);
        box-shadow: inset 3px 0 0 var(--accent);
      }
      .shown {
        max-width: 640px;
      }
    }
  `,
})
export class SettingsShell {
  protected readonly pages = SETTINGS_PAGES;
  protected readonly name = pageName;
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  /** The page shown, from the URL; undefined on the list. */
  protected readonly current = computed(() => pageOf(this.url()));

  private readonly auth = inject(AuthService);
  private readonly themes = inject(ThemeService);
  private readonly startOn = inject(StartOnService);
  private readonly modules = inject(ModulesService);
  private readonly templates = inject(TemplatesService);
  private readonly push = inject(PushService);

  private readonly modeWord = { system: 'follows the system', light: 'light', dark: 'dark' };
  private readonly pushWord: Record<PushState, string> = {
    checking: '',
    working: '',
    unsupported: 'Not in this browser',
    unconfigured: 'Not set up yet',
    off: 'Off on this device',
    blocked: 'Blocked in this browser',
    on: 'On on this device',
    error: 'Could not change',
  };

  /**
   * Each row's quiet line: how it stands, from what this device already
   * has, and nothing that waits on the server.
   */
  protected readonly state = computed((): Record<SettingsPageId, string> => {
    const user = this.auth.user();
    const on = MODULES.filter((m) => this.modules.on(m.id)).map((m) => m.label);
    const n = this.templates.templates().length;
    return {
      appearance: `${themeById(this.themes.theme()).name}, ${this.modeWord[this.themes.mode()]}`,
      'start-on': START_CHOICES.find((c) => c.value === this.startOn.choice())?.label ?? '',
      modules: user ? (on.length ? `${on.join(', ')} on` : 'All off') : '',
      templates: user ? (n ? `${n} template${n === 1 ? '' : 's'}` : 'None yet') : '',
      assistants: 'Connecting, your keys, the daily digest',
      notifications: user ? this.pushWord[this.push.state()] : '',
      device: `Downloads and version ${buildInfo.sha}`,
      // Nothing while sign-in is still being restored.
      account: user ? (user.email ?? 'Signed in') : user === null ? 'Not signed in' : '',
    };
  });
}
