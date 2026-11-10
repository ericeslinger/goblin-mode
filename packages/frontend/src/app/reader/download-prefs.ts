import { Injectable, computed, inject, signal } from '@angular/core';
import { LocalStore } from '../platform/local-store';

const PREFS_KEY = 'goblin.downloads.prefs';

/** The download caps Settings offers, in megabytes (#180). */
export const CAP_CHOICES = [250, 500, 1000, 2000, 5000] as const;
/** The default cap, in megabytes. */
export const DEFAULT_CAP_MB = 500;
/** How many of a podcast's newest episodes may be kept downloaded; 0 is by hand only. */
export const KEEP_CHOICES = [0, 1, 2, 3, 5, 10] as const;
/**
 * A Keep downloaded choice in words, as a show's page and Add a podcast
 * both offer it (#251): "by hand only", "the newest", "the newest 3".
 */
export function keepText(n: number): string {
  return n === 0 ? 'by hand only' : n === 1 ? 'the newest' : `the newest ${n}`;
}
/** A megabyte, as the cap and the sizes count it. */
export const MB = 1024 * 1024;

interface Prefs {
  capMb: number;
  wifiOnly: boolean;
  /** Feed id to how many of its newest episodes to keep downloaded. */
  keep: Record<string, number>;
}

/**
 * The downloads' settings (#180), kept on this device, not in the
 * gardener's settings: the files live in this device's Cache Storage,
 * so a phone and a laptop each want their own cap, Wi-Fi rule and
 * podcasts kept downloaded, as the player's speed is the device's.
 */
@Injectable({ providedIn: 'root' })
export class DownloadPrefs {
  private readonly store = inject(LocalStore);
  private readonly prefs = signal<Prefs>(this.read());

  /** The most the episodes may take on this device, in megabytes. */
  readonly capMb = computed(() => this.prefs().capMb);
  readonly capBytes = computed(() => this.prefs().capMb * MB);
  /** Whether automatic downloads wait for Wi-Fi, where the browser says what the connection is. */
  readonly wifiOnly = computed(() => this.prefs().wifiOnly);
  readonly keep = computed(() => this.prefs().keep);
  /** Whether any podcast keeps its newest episodes downloaded. */
  readonly keepsAny = computed(() => Object.values(this.prefs().keep).some((n) => n > 0));

  keepFor(feedId: string): number {
    return this.prefs().keep[feedId] ?? 0;
  }

  setCap(mb: number): void {
    if (!(CAP_CHOICES as readonly number[]).includes(mb)) return;
    this.update({ capMb: mb });
  }

  setWifiOnly(wifiOnly: boolean): void {
    this.update({ wifiOnly });
  }

  /** Keeps a podcast's newest `n` episodes downloaded; 0 leaves it to the gardener. */
  setKeep(feedId: string, n: number): void {
    const keep = { ...this.prefs().keep };
    if ((KEEP_CHOICES as readonly number[]).includes(n) && n > 0) keep[feedId] = n;
    else delete keep[feedId];
    this.update({ keep });
  }

  private update(change: Partial<Prefs>): void {
    const next = { ...this.prefs(), ...change };
    this.prefs.set(next);
    this.store.set(PREFS_KEY, next);
  }

  private read(): Prefs {
    const raw = this.store.get<Partial<Prefs>>(PREFS_KEY);
    const cap = Number(raw?.capMb);
    const keep: Record<string, number> = {};
    if (raw?.keep && typeof raw.keep === 'object') {
      for (const [id, n] of Object.entries(raw.keep)) {
        if (typeof n === 'number' && (KEEP_CHOICES as readonly number[]).includes(n) && n > 0) {
          keep[id] = n;
        }
      }
    }
    return {
      capMb: (CAP_CHOICES as readonly number[]).includes(cap) ? cap : DEFAULT_CAP_MB,
      wifiOnly: raw?.wifiOnly !== false,
      keep,
    };
  }
}
