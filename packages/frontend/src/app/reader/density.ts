import { Injectable, inject, signal } from '@angular/core';
import { LocalStore } from '../platform/local-store';

/** Where this device keeps the Reader list's density (#288). */
export const DENSITY_KEY = 'goblin.readerDensity';

/**
 * Comfortable: title, source and time, and the summary's first lines.
 * Compact: the title on up to two lines and one line of source and
 * time, no summary.
 */
export type Density = 'comfortable' | 'compact';

/**
 * The Reader list's density (#288, 2026-11-15), kept on this device,
 * not in the gardener's settings: a phone and a laptop each want their
 * own, as the downloads' cap is the device's. Anything but "compact"
 * stored reads as comfortable, the list as it was.
 */
@Injectable({ providedIn: 'root' })
export class ReaderDensity {
  private readonly store = inject(LocalStore);
  readonly value = signal<Density>(
    this.store.get<string>(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable',
  );

  set(density: Density): void {
    this.value.set(density);
    this.store.set(DENSITY_KEY, density);
  }
}
