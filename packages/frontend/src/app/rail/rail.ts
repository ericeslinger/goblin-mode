import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  InjectionToken,
  type Signal,
  computed,
  effect,
  inject,
  input,
  output,
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
import { LocalStore } from '../platform/local-store';
import { Icon } from '../home/icon';
import { PLACES, PlacesService, type PlaceId, RAIL_PLACES, placeLabel } from '../home/places';

/**
 * The full rail, its places named, from this width (#289), as the two
 * panes do (DESIGN.md, Layout); the map's wide screen reads it too.
 * Since 2026-11-22 only the default: the menu button's choice, once
 * made, decides instead.
 */
export const RAIL_QUERY = '(min-width: 900px)';
/**
 * The rail is drawn from this width (#289, Eric 2026-11-15; built
 * 2026-11-16): from here to RAIL_QUERY as icons alone, a tablet's,
 * beside the phone's one column.
 */
export const ICON_RAIL_QUERY = '(min-width: 641px)';
/** The class on `<html>` while the rail is drawn; styles.css gives `--rail-width` by it. */
export const RAIL_CLASS = 'has-rail';
/**
 * The class on `<html>` while the drawn rail is icons alone: with it
 * `--rail-width` is 64 px, without it 176 (2026-11-22).
 */
export const RAIL_ICONS_CLASS = 'rail-icons';
/**
 * Where this device keeps the rail's menu button's choice (Eric,
 * 2026-11-22): "icons" or "words", one choice for every width the
 * rail is drawn at. Nothing stored, the width decides.
 */
export const RAIL_KEY = 'goblin.rail';
export type RailChoice = 'icons' | 'words';

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

/**
 * Whether a media query matches, kept up to date; false where
 * matchMedia is missing. Call it in an injection context.
 */
function matches(media: string): Signal<boolean> {
  const matched = signal(false);
  const query = typeof matchMedia === 'function' ? matchMedia(media) : undefined;
  if (query) {
    const onChange = () => matched.set(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    inject(DestroyRef).onDestroy(() => query.removeEventListener?.('change', onChange));
  }
  return matched.asReadonly();
}

/** The rail's stored choice, or undefined for none or anything else stored. */
function readChoice(store: LocalStore): RailChoice | undefined {
  const stored = store.get<unknown>(RAIL_KEY);
  return stored === 'icons' || stored === 'words' ? stored : undefined;
}

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
    case 'habits':
      return 'habits';
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
 * one; Settings last, at the foot. With `icons` (641 to 899 px,
 * 2026-11-16) each is its icon alone: the name is still there for
 * screen readers, the link's name is as it was, its title is the same
 * words for a mouse, and the count is a badge on the icon.
 *
 * With `menu` (Eric, 2026-11-22) a menu button of three lines comes
 * first, the first stop in the rail's Tab order: it asks for the other
 * presentation through `toggled`, named for what it will do, its
 * `aria-expanded` true while the names show.
 */
@Component({
  selector: 'app-rail-nav',
  imports: [RouterLink, Icon],
  template: `
    <nav id="rail-places" aria-label="Places" [class.icons]="icons()">
      @if (menu()) {
        <button
          type="button"
          class="menu"
          aria-controls="rail-places"
          [attr.aria-expanded]="!icons()"
          [attr.aria-label]="menuLabel()"
          [attr.title]="menuLabel()"
          (click)="toggled.emit()"
        >
          <app-icon name="menu" [size]="20" />
        </button>
      }
      @for (e of entries(); track e.id) {
        <a
          [routerLink]="e.link"
          [class.foot]="e.id === 'settings'"
          [attr.aria-current]="e.current ? 'page' : null"
          [attr.aria-label]="e.label"
          [attr.title]="icons() ? e.label : null"
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
    /* The menu button (2026-11-22): a 44 px square whose icon lines up
       with the entries' icons below it; across the strip, as an entry
       is, while the rail is icons. */
    .menu {
      display: flex;
      flex: none;
      align-items: center;
      box-sizing: border-box;
      width: 44px;
      min-height: 44px;
      margin-bottom: var(--space-1);
      padding: 0 var(--space-2);
      color: var(--ink);
      background: none;
      border: none;
      border-radius: var(--radius-control);
    }
    .menu:hover {
      background: var(--chip-bg);
    }
    .menu:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .icons .menu {
      justify-content: center;
      width: auto;
      min-height: 48px;
      padding: 0;
    }
    /* Icons alone (641 to 899 px, 2026-11-16, or as the menu button
       chose, 2026-11-22): the strip is --rail-width, 64 px, and each
       entry 48 px tall across it. */
    nav.icons {
      padding: var(--space-2) var(--space-1);
      overflow-x: hidden;
    }
    .icons a {
      position: relative;
      justify-content: center;
      min-height: 48px;
      padding: 0;
    }
    /* The current one has a bar at its edge too, not the chip alone. */
    .icons a[aria-current] {
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .icons .name {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    /* On the icon's upper right, centred there so "999+" still fits. */
    .icons .count {
      position: absolute;
      top: 4px;
      left: calc(50% + 8px);
      transform: translateX(-50%);
      box-sizing: border-box;
      min-width: 16px;
      padding: 0 3px;
      font-size: 11px;
      font-weight: 400;
      line-height: 14px;
      text-align: center;
      color: var(--ink);
      background: var(--surface);
      border: 1px solid var(--rule);
      border-radius: var(--radius-pill);
    }
  `,
})
export class RailNav {
  /** The URL shown, for the current entry. */
  readonly url = input.required<string>();
  /** Icons alone: the tablet's rail (641 to 899 px), or as chosen. */
  readonly icons = input(false);
  /** The menu button, to switch between names and icons (2026-11-22). */
  readonly menu = input(false);
  /** The menu button was pressed: the other presentation is asked for. */
  readonly toggled = output<void>();
  protected readonly menuLabel = computed(() =>
    this.icons() ? 'Expand navigation' : 'Collapse navigation',
  );
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
 * the first thing Tab reaches. From 641 to 899 px (2026-11-16) the same
 * rail as icons alone, beside the phone's layout. Not drawn signed
 * out, on the sign-in screens, the development sign-in or Claude's
 * consent page, nor under 641 px, where nothing changes. While it is
 * drawn, `<html>` has RAIL_CLASS, by which styles.css sets
 * `--rail-width` and the body's left padding.
 *
 * Its menu button (Eric, 2026-11-22) switches it between the two
 * presentations, names and icons, at any width it is drawn at. Until
 * it is first pressed the width decides, as before; then the choice,
 * one for every width, is kept on this device (RAIL_KEY) and decides
 * instead. While the rail is icons `<html>` has RAIL_ICONS_CLASS too,
 * by which `--rail-width` is 64 px rather than 176.
 */
@Component({
  selector: 'app-rail',
  imports: [RailNav],
  template: `
    @if (shown()) {
      <a class="skip" href="#content" (click)="skip($event)">Skip to content</a>
      <app-rail-nav [url]="url()" [icons]="icons()" [menu]="true" (toggled)="toggle()" />
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
  private readonly store = inject(LocalStore);

  /** The window is 900 px or wider: the full rail, unless chosen otherwise. */
  private readonly wide = matches(RAIL_QUERY);
  /** The menu button's choice on this device; undefined until it is first pressed. */
  private readonly choice = signal<RailChoice | undefined>(readChoice(this.store));
  /** Icons alone: as chosen, else under 900 px. */
  protected readonly icons = computed(() => {
    const choice = this.choice();
    return choice ? choice === 'icons' : !this.wide();
  });
  /** The window is 641 px or wider: a rail, of icons until `wide`. */
  private readonly drawn = matches(ICON_RAIL_QUERY);
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
  protected readonly shown = computed(
    () => this.drawn() && this.signedIn() && !offRail(this.url()),
  );

  constructor() {
    effect(() => {
      const classes = this.doc.documentElement.classList;
      classes.toggle(RAIL_CLASS, this.shown());
      classes.toggle(RAIL_ICONS_CLASS, this.shown() && this.icons());
    });
    inject(DestroyRef).onDestroy(() =>
      this.doc.documentElement.classList.remove(RAIL_CLASS, RAIL_ICONS_CLASS),
    );
  }

  /** The menu button: the other presentation, kept on this device. */
  protected toggle(): void {
    const next: RailChoice = this.icons() ? 'words' : 'icons';
    this.choice.set(next);
    this.store.set(RAIL_KEY, next);
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
