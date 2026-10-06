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
