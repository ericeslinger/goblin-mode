import { Injectable, effect, inject, signal } from '@angular/core';
import { type CanActivateFn, RedirectCommand, Router } from '@angular/router';
import { StartOn } from '@mossgoblin/schema';
import { LastPlaceService } from '../launch/last-place.service';
import { ModulesService } from '../modules/modules.service';
import { LocalStore } from '../platform/local-store';

/**
 * Start on (#219), kept on this device so a cold open lands before auth
 * and offline, as the theme is; the gardener's `settings/app` doc is
 * the source of truth once signed in (ThemeSync carries it). With it,
 * whether Kitchen, the Reader and Podcasts (#245) were on when last
 * known, so a choice
 * of a module that is off falls back to Home without waiting for the
 * modules doc.
 */
export const START_ON_KEY = 'goblin.startOn';

interface Stored {
  choice?: string;
  kitchen?: boolean;
  reader?: boolean;
  podcasts?: boolean;
}

/** Which of the modules Start on can open are on. */
export interface StartModules {
  kitchen: boolean;
  reader: boolean;
  podcasts: boolean;
}

/**
 * Where a cold open of `/` goes, for a choice and the modules on. For
 * `note`, Where I left off since 2026-11-15 (#272), `/` here: the guard
 * asks LastPlaceService where that is.
 */
export function startPath(choice: StartOn, on: StartModules): string {
  switch (choice) {
    case 'note':
      return '/';
    case 'home':
      return '/home';
    case 'right-now':
      return '/right-now';
    case 'kitchen':
      return on.kitchen ? '/kitchen' : '/home';
    case 'reader':
      return on.reader ? '/reader' : '/home';
    case 'podcasts':
      return on.podcasts ? '/podcasts' : '/home';
  }
}

@Injectable({ providedIn: 'root' })
export class StartOnService {
  private readonly store = inject(LocalStore);
  private stored = this.store.get<Stored>(START_ON_KEY) ?? {};

  /**
   * The choice; `note` until one is made. Stored as `note` since #219,
   * when it meant a new note; since 2026-11-15 (#272, Eric) it means
   * Where I left off, the place open last on this device.
   */
  readonly choice = signal<StartOn>(StartOn.safeParse(this.stored.choice).data ?? 'note');
  /** Counts choices made here, for ThemeSync to write; adopted ones do not count. */
  readonly chosen = signal(0);

  /** Whether this device has a choice of its own, to upload to a new doc. */
  hasStoredChoice(): boolean {
    return this.stored.choice !== undefined;
  }

  /** A choice made here: kept, and written to the doc by ThemeSync. */
  set(choice: StartOn): void {
    this.adopt(choice);
    this.chosen.update((n) => n + 1);
  }

  /** A choice from the doc, made on this or another device. */
  adopt(choice: StartOn): void {
    this.choice.set(choice);
    this.keep({ choice });
  }

  /** The modules as last read, for the next cold open. */
  remember(on: StartModules): void {
    const s = this.stored;
    if (on.kitchen === s.kitchen && on.reader === s.reader && on.podcasts === s.podcasts) return;
    this.keep(on);
  }

  /** Where a cold open goes: the modules as read, else as last known. */
  path(modules: ModulesService): string {
    return startPath(this.choice(), this.on(modules));
  }

  /** Which modules are on: as read, else as last known on this device. */
  on(modules: ModulesService): StartModules {
    return modules.loaded()
      ? { kitchen: modules.kitchen(), reader: modules.reader(), podcasts: modules.podcasts() }
      : {
          kitchen: !!this.stored.kitchen,
          reader: !!this.stored.reader,
          podcasts: !!this.stored.podcasts,
        };
  }

  private keep(change: Stored): void {
    this.stored = { ...this.stored, ...change };
    this.store.set(START_ON_KEY, this.stored);
  }
}

/**
 * Keeps which modules are on for the next cold open; run once, at boot.
 * Only once the modules doc is read: the defaults are not the gardener's.
 */
export function rememberModules(): void {
  const startOn = inject(StartOnService);
  const modules = inject(ModulesService);
  effect(() => {
    if (modules.loaded())
      startOn.remember({
        kitchen: modules.kitchen(),
        reader: modules.reader(),
        podcasts: modules.podcasts(),
      });
  });
}

/**
 * On a cold open of `/` and nothing else, the screen chosen in Start on:
 * by default (Where I left off, #272) the place open last on this
 * device, its scroll and all. A share, a Send to, a note's link, a
 * notification or any URL with more to it opens as it says, and moving
 * around the app (the Home box, New note, a link to `/`) never comes
 * back through here: only the first navigation does. It reads only
 * this device's store: nothing waits on auth or the network.
 */
export const startOnGuard: CanActivateFn = (_route, state) => {
  const router = inject(Router);
  if (router.navigated || state.url !== '/') return true;
  const startOn = inject(StartOnService);
  const modules = inject(ModulesService);
  const path =
    startOn.choice() === 'note'
      ? inject(LastPlaceService).launch(startOn.on(modules))
      : startOn.path(modules);
  return path === '/' ? true : new RedirectCommand(router.parseUrl(path), { replaceUrl: true });
};
