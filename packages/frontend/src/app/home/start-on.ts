import { Injectable, effect, inject, signal } from '@angular/core';
import { type CanActivateFn, RedirectCommand, Router } from '@angular/router';
import { StartOn } from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { LocalStore } from '../platform/local-store';

/**
 * Start on (#219), kept on this device so a cold open lands before auth
 * and offline, as the theme is; the gardener's `settings/app` doc is
 * the source of truth once signed in (ThemeSync carries it). With it,
 * whether Kitchen and the Reader were on when last known, so a choice
 * of a module that is off falls back to Home without waiting for the
 * modules doc.
 */
export const START_ON_KEY = 'goblin.startOn';

interface Stored {
  choice?: string;
  kitchen?: boolean;
  reader?: boolean;
}

/** Where a cold open of `/` goes, for a choice and the modules on. */
export function startPath(choice: StartOn, on: { kitchen: boolean; reader: boolean }): string {
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
  }
}

@Injectable({ providedIn: 'root' })
export class StartOnService {
  private readonly store = inject(LocalStore);
  private stored = this.store.get<Stored>(START_ON_KEY) ?? {};

  /** The choice; a new note until one is made, as before #219. */
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
  remember(on: { kitchen: boolean; reader: boolean }): void {
    if (on.kitchen === this.stored.kitchen && on.reader === this.stored.reader) return;
    this.keep(on);
  }

  /** Where a cold open goes: the modules as read, else as last known. */
  path(modules: ModulesService): string {
    const on = modules.loaded()
      ? { kitchen: modules.kitchen(), reader: modules.reader() }
      : { kitchen: !!this.stored.kitchen, reader: !!this.stored.reader };
    return startPath(this.choice(), on);
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
      startOn.remember({ kitchen: modules.kitchen(), reader: modules.reader() });
  });
}

/**
 * On a cold open of `/` and nothing else, the screen chosen in Start on.
 * A share, a Send to, a note's link or any URL with more to it opens as
 * it says, and moving around the app never comes back through here. It
 * reads only this device's store: nothing waits on auth or the network.
 */
export const startOnGuard: CanActivateFn = (_route, state) => {
  const router = inject(Router);
  if (router.navigated || state.url !== '/') return true;
  const startOn = inject(StartOnService);
  if (startOn.choice() === 'note') return true;
  const path = startOn.path(inject(ModulesService));
  return path === '/' ? true : new RedirectCommand(router.parseUrl(path), { replaceUrl: true });
};
