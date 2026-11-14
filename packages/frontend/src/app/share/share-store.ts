import { Injectable, inject, signal } from '@angular/core';
import { STORAGE } from '../platform/platform';
import type { Shared } from './shared';

/**
 * Shares taken in and not yet filed (2026-11-14, DESIGN.md, Share to
 * Mossgoblin), on this device: what was shared is kept here the moment
 * /share opens, before anything waits on auth or the network, and is
 * forgotten only once it has been filed (or let go). Signed out, it
 * waits here through sign-in.
 */
export const PENDING_SHARES_KEY = 'goblin.pendingShares';
/** The keys of the shares lately taken in, so a reload never files one twice. */
export const SHARES_TAKEN_KEY = 'goblin.sharesTaken';
/** How many taken keys are remembered; a reload comes within moments. */
const TAKEN_KEPT = 50;

export interface PendingShare extends Shared {
  /** When it was taken in, in milliseconds. */
  takenAt: number;
  /**
   * The recipe being made from its words (Import as a recipe from this
   * text), chosen before it is written, so asking again reuses it.
   */
  recipeId?: string;
}

@Injectable({ providedIn: 'root' })
export class ShareStore {
  private readonly storage = inject(STORAGE);

  /** Waiting to be filed, oldest first. */
  readonly pending = signal<PendingShare[]>(this.read<PendingShare[]>(PENDING_SHARES_KEY) ?? []);
  /**
   * False when the device would not keep the last change (storage full,
   * refused, or a share too long for it): what is shown stays in memory
   * only, and the page says so.
   */
  readonly kept = signal(true);

  /**
   * Takes a share in: kept, unless it is one taken before (a reload of
   * its address). Returns the share as waiting, or undefined if it was
   * taken before and has been filed since.
   */
  take(shared: Shared, now: number): PendingShare | undefined {
    const waiting = this.pending().find((p) => p.key === shared.key);
    if (waiting) return waiting;
    const taken = this.read<string[]>(SHARES_TAKEN_KEY) ?? [];
    if (taken.includes(shared.key)) return undefined;
    const share: PendingShare = { ...shared, takenAt: now };
    this.save([...this.pending(), share]);
    this.write(SHARES_TAKEN_KEY, [...taken, shared.key].slice(-TAKEN_KEPT));
    return share;
  }

  /** Notes something about a waiting share (its recipe's id). */
  update(key: string, change: Partial<Pick<PendingShare, 'recipeId'>>): void {
    this.save(this.pending().map((p) => (p.key === key ? { ...p, ...change } : p)));
  }

  /** Filed, or let go: forgotten. */
  done(key: string): void {
    this.save(this.pending().filter((p) => p.key !== key));
  }

  private save(shares: PendingShare[]): void {
    this.pending.set(shares);
    this.kept.set(
      shares.length ? this.write(PENDING_SHARES_KEY, shares) : this.remove(PENDING_SHARES_KEY),
    );
  }

  private read<T>(key: string): T | undefined {
    try {
      const raw = this.storage?.getItem(key);
      return raw == null ? undefined : (JSON.parse(raw) as T);
    } catch {
      return undefined;
    }
  }

  /** Whether the device kept it: read back, as a full store refuses quietly. */
  private write(key: string, value: unknown): boolean {
    try {
      const raw = JSON.stringify(value);
      this.storage?.setItem(key, raw);
      return this.storage?.getItem(key) === raw;
    } catch {
      return false;
    }
  }

  private remove(key: string): boolean {
    try {
      this.storage?.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }
}
