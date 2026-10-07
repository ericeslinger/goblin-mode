import { InjectionToken } from '@angular/core';

/**
 * Ambient inputs, injected so specs can control them (house style:
 * clock, randomness and storage reach logic as parameters).
 */
export const NOW = new InjectionToken<() => number>('now', {
  providedIn: 'root',
  factory: () => () => Date.now(),
});

/** Fills a byte array with random bytes, in place. */
export const RANDOM_BYTES = new InjectionToken<(bytes: Uint8Array<ArrayBuffer>) => void>('random', {
  providedIn: 'root',
  factory: () => (bytes: Uint8Array<ArrayBuffer>) => void crypto.getRandomValues(bytes),
});

/** localStorage, or null where it is unavailable (some private modes). */
export const STORAGE = new InjectionToken<Storage | null>('storage', {
  providedIn: 'root',
  factory: () => {
    try {
      return localStorage;
    } catch {
      return null;
    }
  },
});

/** The device's IANA time zone, for "today" and for new repeats. */
export const TIME_ZONE = new InjectionToken<string>('time-zone', {
  providedIn: 'root',
  factory: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
});

/** Whether the browser thinks it is online (navigator.onLine). */
export const ONLINE = new InjectionToken<() => boolean>('online', {
  providedIn: 'root',
  factory: () => () => typeof navigator === 'undefined' || navigator.onLine,
});
