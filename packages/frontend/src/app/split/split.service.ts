import { Injectable, signal } from '@angular/core';

const KEY = 'goblin.rightNowShare';
export const MIN_SHARE = 15;
export const MAX_SHARE = 80;
export const DEFAULT_SHARE = 35;

/** Keeps a share of the screen within bounds, rounded to a whole percent. */
export function clampShare(share: number): number {
  if (!Number.isFinite(share)) return DEFAULT_SHARE;
  return Math.round(Math.min(MAX_SHARE, Math.max(MIN_SHARE, share)));
}

/**
 * How much of the launch screen Right Now takes, as a percent of the
 * viewport height, remembered on this device.
 */
@Injectable({ providedIn: 'root' })
export class SplitService {
  readonly rightNowShare = signal(this.read());

  /** Changes the share for now, without saving (during a drag). */
  preview(share: number): void {
    this.rightNowShare.set(clampShare(share));
  }

  /** Changes the share and remembers it on this device. */
  set(share: number): void {
    this.preview(share);
    try {
      localStorage.setItem(KEY, String(this.rightNowShare()));
    } catch {
      // Not persisted; fine.
    }
  }

  private read(): number {
    try {
      const stored = localStorage.getItem(KEY);
      return stored === null ? DEFAULT_SHARE : clampShare(Number(stored));
    } catch {
      return DEFAULT_SHARE;
    }
  }
}
