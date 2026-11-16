import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from '../auth.service';
import { GroceryService } from '../kitchen/grocery.service';
import { kitchenTabOf } from '../kitchen/kitchen-tabs';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { Icon } from '../home/icon';
import { PLACES, PlacesService, type PlaceId, RAIL_PLACES, placeLabel } from '../home/places';

/** The rail shows from this width (#289), as the two panes do (DESIGN.md, Layout). */
export const RAIL_QUERY = '(min-width: 900px)';
/** The class on `<html>` while the rail is drawn; styles.css gives `--rail-width` by it. */
export const RAIL_CLASS = 'has-rail';

/**
 * The address the page was opened at, path and query, from the document
 * (#289): the rail's URL until the router's first navigation ends, when
 * `router.url` is still `/`. Without it a cold load of a screen off the
 * rail drew the rail for a moment, and one of `/reader` marked Notes.
 */
export const OPENED_AT = new InjectionToken<string>('rail-opened-at', {
  providedIn: 'root',
  factory: () => {
    const location = inject(DOCUMENT).location;
    return location ? location.pathname + location.search : '/';
  },
});

/** Screens that are not the garden's: sign-in for development, and Claude's consent page. */
const OFF_RAIL = ['dev-sign-in', 'oauth'];

/** The first two segments of a URL's path. */
function segments(url: string): string[] {
  return url.split(/[?#]/)[0].split('/').filter(Boolean);
}

/** Whether a URL is a screen the rail stays off. */
export function offRail(url: string): boolean {
  return OFF_RAIL.includes(segments(url)[0] ?? '');
}

/**
 * The rail's entry a URL is under (#289): a note is Notes, unless it is
 * one of Kitchen's tabs (a week's plan, the pantry, a grocery list);
 * History is a note's, so Notes too; Downloads is Podcasts' while
 * Podcasts is on. Undefined where no entry is (the share page).
 */
export function currentPlace(
  url: string,
  { kitchenNote, podcastsOn }: { kitchenNote: (id: string) => boolean; podcastsOn: boolean },
): PlaceId | undefined {
  const [first = '', second] = segments(url);
  switch (first) {
    case '':
    case 'browse':
    case 'history':
      return 'notes';
    case 'n':
      return second && kitchenNote(decodeURIComponent(second)) ? 'kitchen' : 'notes';
    case 'home':
      return 'home';
    case 'right-now':
      return 'right-now';
    case 'kitchen':
      return 'kitchen';
    case 'reader':
      return second === 'downloads' && podcastsOn ? 'podcasts' : 'reader';
    case 'podcasts':
      return 'podcasts';
    case 'reading':
      return 'reading';
    case 'map':
      return 'map';
    case 'activity':
      return 'assistants';
    case 'settings':
      return 'settings';
    default:
      return undefined;
  }
}

/**
 * The rail's entries (#289): each place in order, a module that is off
 * left out as its Home tile is, with its count where Home's tile has
 * one; Settings last, at the foot.
 */
@Component({
  selector: 'app-rail-nav',
  imports: [RouterLink, Icon],
  template: `
    <nav aria-label="Places">
      @for (e of entries(); track e.id) {
        <a
          [routerLink]="e.link"
          [class.foot]="e.id === 'settings'"
          [attr.aria-current]="e.current ? 'page' : null"
          [attr.aria-label]="e.label"
        >
          <app-icon [name]="e.icon" [size]="20" />
          <span class="name">{{ e.name }}</span>
          @if (e.count) {
            <span class="count">{{ e.count }}</span>
          }
        </a>
      }
    </nav>
  `,
  styles: `
    nav {
      position: fixed;
      top: 0;
      left: 0;
      /* Above the mini-player, which is the width of the page. */
      bottom: var(--mini-player-height, 0px);
      z-index: 3;
      box-sizing: border-box;
      width: var(--rail-width);
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--space-3) var(--space-2);
      overflow-y: auto;
      overscroll-behavior: contain;
      background: var(--bg);
      border-right: var(--border, 1px) solid var(--rule);
    }
    a {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 36px;
      padding: 4px var(--space-2);
      box-sizing: border-box;
      border-radius: var(--radius-control);
      color: var(--ink);
      font-size: 14px;
      text-decoration: none;
    }
    a:hover {
      background: var(--chip-bg);
    }
    /* The current entry: bold on the chip colour, not by colour alone. */
    a[aria-current] {
      font-weight: 600;
      background: var(--chip-bg);
    }
    a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    /* A long name wraps between words, never inside one. */
    .name {
      flex: 1 1 auto;
      min-width: 0;
    }
    .count {
      flex: none;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--quiet);
    }
    .foot {
      margin-top: auto;
    }
  `,
})
export class RailNav {
  /** The URL shown, for the current entry. */
  readonly url = input.required<string>();
  private readonly places = inject(PlacesService);
  private readonly notes = inject(NotesService);
  private readonly modules = inject(ModulesService);
  private readonly grocery = inject(GroceryService);

  private readonly current = computed(() =>
    currentPlace(this.url(), {
      kitchenNote: (id) =>
        !!kitchenTabOf(this.notes.find(id), this.modules.kitchen(), (n) => this.grocery.isList(n)),
      podcastsOn: this.modules.podcasts(),
    }),
  );

  protected readonly entries = computed(() => {
    const on = this.places.isOn();
    const counts = this.places.counts();
    const current = this.current();
    return [...RAIL_PLACES.filter(on), 'settings' as const].map((id) => {
      const count = counts[id];
      const n = count?.n ?? 0;
      return {
        id,
        ...PLACES[id],
        current: id === current,
        label: placeLabel(PLACES[id].name, count),
        count: n > 0 ? (n > 999 ? '999+' : String(n)) : undefined,
      };
    });
  });
}

/**
 * The desktop shell's rail (#289, Eric 2026-11-15): from 900 px, on
 * every screen of the garden, a column of its places fixed at the left
 * edge, the page beside it; with a "Skip to content" link before it,
 * the first thing Tab reaches. Not drawn signed out, on the sign-in
 * screens, the development sign-in or Claude's consent page, nor under
 * 900 px, where nothing changes. While it is drawn, `<html>` has
 * RAIL_CLASS, by which styles.css sets `--rail-width` and the body's
 * left padding.
 */
@Component({
  selector: 'app-rail',
  imports: [RailNav],
  template: `
    @if (shown()) {
      <a class="skip" href="#content" (click)="skip($event)">Skip to content</a>
      <app-rail-nav [url]="url()" />
    }
  `,
  styles: `
    /* Out of sight until focused, then over the rail's top. */
    .skip {
      position: fixed;
      top: var(--space-2);
      left: var(--space-2);
      z-index: 4;
      padding: var(--space-2) var(--space-3);
      color: var(--ink);
      background: var(--surface);
      border: var(--border, 1px) solid var(--rule);
      border-radius: var(--radius-control);
      transform: translateY(calc(-100% - var(--space-3)));
    }
    .skip:focus {
      transform: none;
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
  `,
})
export class Rail {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);

  /** The window is 900 px or wider. */
  private readonly wide = signal(false);
  protected readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.navigated ? this.router.url : inject(OPENED_AT) },
  );
  /**
   * Signed in, or restoring on a device signed in before, as the note
   * screen shows its editor (Launch's showSignIn), so the page does not
   * move under the first keystrokes.
   */
  private readonly signedIn = computed(() => {
    const user = this.auth.user();
    return !!user || (user === undefined && this.auth.signedInBefore());
  });
  protected readonly shown = computed(() => this.wide() && this.signedIn() && !offRail(this.url()));

  constructor() {
    const query = typeof matchMedia === 'function' ? matchMedia(RAIL_QUERY) : undefined;
    if (query) {
      const onChange = () => this.wide.set(query.matches);
      onChange();
      query.addEventListener?.('change', onChange);
      inject(DestroyRef).onDestroy(() => query.removeEventListener?.('change', onChange));
    }
    effect(() => this.doc.documentElement.classList.toggle(RAIL_CLASS, this.shown()));
    inject(DestroyRef).onDestroy(() => this.doc.documentElement.classList.remove(RAIL_CLASS));
  }

  /**
   * To the screen's content: on the note screen (`/`, `/n/<id>`) the
   * note's text, so what is typed next goes into the note (it has no
   * `main`, and its host would put the next Tab on the bar); elsewhere
   * the screen's `main` where it has one, else the screen itself,
   * focused without a stop in the Tab order.
   */
  protected skip(event: Event): void {
    event.preventDefault();
    const screen = this.doc.querySelector('app-root > router-outlet')?.nextElementSibling;
    const [first = ''] = segments(this.url());
    const note =
      first === '' || first === 'n'
        ? screen?.querySelector<HTMLElement>('app-note-editor .cm-content')
        : null;
    if (note) {
      // CodeMirror's own content element: focusing it is the editor's focus().
      note.focus();
      return;
    }
    const target = screen?.querySelector('main') ?? screen;
    if (!(target instanceof HTMLElement)) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
  }
}
