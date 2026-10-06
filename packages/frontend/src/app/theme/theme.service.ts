import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, computed, effect, inject, signal } from '@angular/core';
import { LocalStore } from '../platform/local-store';
import { type Mode, type ThemeId, THEME_IDS, themeById, tokensFor } from './themes';

/** Kept on this device until the choice is saved per user (#24). */
export const THEME_KEY = 'goblin.theme';

export type ModeChoice = Mode | 'system';

interface Stored {
  theme?: string;
  mode?: string;
}

/** The system's dark-mode query, or null where matchMedia is missing. */
export const PREFERS_DARK = new InjectionToken<MediaQueryList | null>('prefers-dark', {
  providedIn: 'root',
  factory: () => {
    try {
      return matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return null;
    }
  },
});

/**
 * The active theme and mode. Copies the theme's tokens onto <html> as
 * custom properties, marks <html> with data-theme and data-mode, and
 * keeps the browser's theme-color in step.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly store = inject(LocalStore);
  private readonly query = inject(PREFERS_DARK);

  private readonly stored = this.store.get<Stored>(THEME_KEY) ?? {};
  readonly theme = signal<ThemeId>(themeById(this.stored.theme).id);
  readonly mode = signal<ModeChoice>(
    this.stored.mode === 'light' || this.stored.mode === 'dark' ? this.stored.mode : 'system',
  );
  private readonly systemDark = signal(this.query?.matches ?? false);
  /** The mode actually shown, with 'system' resolved. */
  readonly shown = computed<Mode>(() => {
    const mode = this.mode();
    if (mode !== 'system') return mode;
    return this.systemDark() ? 'dark' : 'light';
  });

  constructor() {
    this.query?.addEventListener('change', (e) => this.systemDark.set(e.matches));
    // Applied now, before the first render, and again on every change.
    this.apply();
    effect(() => this.apply());
  }

  set(theme: ThemeId, mode: ModeChoice = this.mode()): void {
    if (!THEME_IDS.includes(theme)) return;
    this.theme.set(theme);
    this.mode.set(mode);
    this.store.set(THEME_KEY, { theme, mode });
  }

  private apply(): void {
    const theme = themeById(this.theme());
    const mode = this.shown();
    const root = this.doc.documentElement;
    for (const [name, value] of Object.entries(tokensFor(theme, mode))) {
      root.style.setProperty(name, value);
    }
    root.style.setProperty('color-scheme', mode);
    root.dataset['theme'] = theme.id;
    root.dataset['mode'] = mode;
    this.doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme[mode].bg);
  }
}
