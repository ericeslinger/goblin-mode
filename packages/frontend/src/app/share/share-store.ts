import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { autoId } from '@mossgoblin/schema';
import { RANDOM_BYTES, STORAGE } from '../platform/platform';
import type { RawShare } from './shared';

/**
 * Shares taken in and not yet filed (2026-11-14, DESIGN.md, Share to
 * Mossgoblin), on this device: what was shared is kept here the moment
 * /share opens, as it came and before it is read, and before anything
 * waits on auth or the network, and is forgotten only once it has been
 * filed (or let go). Signed out, it waits here through sign-in.
 *
 * Every change reads the store afresh and writes it back at once
 * (review on #271): the installed app and a browser tab share it, and
 * one must never write an old copy back over what the other took in.
 */
export const PENDING_SHARES_KEY = 'goblin.pendingShares';
/** The keys of the shares lately taken in, so a reload never files one twice. */
export const SHARES_TAKEN_KEY = 'goblin.sharesTaken';
/** How many taken keys are remembered; a reload comes within moments. */
const TAKEN_KEPT = 50;

/** Where `sw.js` keeps words too long for an address (review on #271). */
export const SHARE_WORDS_CACHE = 'mossgoblin-share-words';

/** The words `sw.js` kept for a share, read back by its stash id; a seam for specs. */
export interface ShareWords {
  read(stash: string): Promise<Omit<RawShare, 'at'> | undefined>;
  remove(stash: string): Promise<void>;
}

export const SHARE_WORDS = new InjectionToken<ShareWords>('share-words', {
  providedIn: 'root',
  factory: () => {
    const path = (stash: string) => `/share-words/${encodeURIComponent(stash)}`;
    return {
      async read(stash) {
        if (!('caches' in globalThis)) return undefined;
        const hit = await (await caches.open(SHARE_WORDS_CACHE)).match(path(stash));
        if (!hit) return undefined;
        const v = (await hit.json()) as Partial<Record<'title' | 'text' | 'url', unknown>>;
        const str = (x: unknown) => (typeof x === 'string' ? x : '');
        return { title: str(v.title), text: str(v.text), url: str(v.url) };
      },
      async remove(stash) {
        if (!('caches' in globalThis)) return;
        await (await caches.open(SHARE_WORDS_CACHE)).delete(path(stash));
      },
    };
  },
});

export interface PendingShare extends RawShare {
  /** Tells it from a reload of it (`shareKey`). */
  key: string;
  /** When it was taken in, in milliseconds. */
  takenAt: number;
  /**
   * Whose it is, when someone was signed in as it came: it is shown and
   * filed for them only. Absent, it goes to whoever signs in next.
   */
  uid?: string;
  /** Its words are in `SHARE_WORDS_CACHE` under this id, not here. */
  stash?: string;
  /**
   * The recipe being made from its words (Import as a recipe from this
   * text), chosen before it is written, so asking again reuses it.
   */
  recipeId?: string;
  /** Being filed by one window until `until`: another leaves it be. */
  filing?: { by: string; until: number };
}

@Injectable({ providedIn: 'root' })
export class ShareStore {
  private readonly storage = inject(STORAGE);
  private readonly words = inject(SHARE_WORDS);
  /** This window, for claiming a share while it is filed. */
  readonly window = autoId(inject(RANDOM_BYTES));

  /**
   * False when the device would not keep the last change (storage full,
   * refused, or a share too long for it): the shares are then held in
   * memory only, and the page says so.
   */
  readonly kept = signal(true);
  /** Waiting to be filed, oldest first, as the store last read. */
  readonly pending = signal<PendingShare[]>(this.stored() ?? []);

  constructor() {
    // Another window changed the store: show what it holds now.
    const view = inject(DOCUMENT).defaultView;
    const changed = (e: StorageEvent) => {
      if (e.key === PENDING_SHARES_KEY || e.key === null) this.pending.set(this.current());
    };
    view?.addEventListener('storage', changed);
    inject(DestroyRef).onDestroy(() => view?.removeEventListener('storage', changed));
  }

  /** The shares `uid` may see: theirs, and those that came signed out. */
  visibleTo(uid: string | null | undefined): PendingShare[] {
    return this.pending().filter((p) => !p.uid || p.uid === uid);
  }

  /**
   * Takes a share in, as it came: kept, unless it is one taken before
   * (a reload of its address). Returns the share as waiting, or
   * undefined if it was taken before and has been filed since.
   */
  take(
    raw: RawShare & { key: string; stash?: string },
    { now, uid }: { now: number; uid?: string },
  ): PendingShare | undefined {
    const pending = this.current();
    this.pending.set(pending);
    const waiting = pending.find((p) => p.key === raw.key);
    if (waiting) return waiting;
    const taken = this.read<string[]>(SHARES_TAKEN_KEY) ?? [];
    if (taken.includes(raw.key)) return undefined;
    const share: PendingShare = { ...raw, takenAt: now };
    if (uid) share.uid = uid;
    if (!share.stash) delete share.stash;
    this.save([...pending, share]);
    this.write(SHARES_TAKEN_KEY, [...taken, raw.key].slice(-TAKEN_KEPT));
    return share;
  }

  /** Notes something about a waiting share (its recipe's id). */
  update(key: string, change: Partial<Pick<PendingShare, 'recipeId'>>): void {
    this.save(this.current().map((p) => (p.key === key ? { ...p, ...change } : p)));
  }

  /**
   * Claims a share for this window while it is filed, for `ms`: false
   * if it is gone, or another window holds it. Written and read back,
   * so of two windows at once only one goes on.
   */
  claim(key: string, now: number, ms: number): boolean {
    const pending = this.current();
    const share = pending.find((p) => p.key === key);
    if (!share || this.heldElsewhere(share, now)) {
      this.pending.set(pending);
      return false;
    }
    const filing = { by: this.window, until: now + ms };
    this.save(pending.map((p) => (p.key === key ? { ...p, filing } : p)));
    return this.current().find((p) => p.key === key)?.filing?.by === this.window;
  }

  /** Lets go of a claim this window made, the share still waiting. */
  release(key: string): void {
    this.save(
      this.current().map((p) => {
        if (p.key !== key || p.filing?.by !== this.window) return p;
        const { filing: _, ...rest } = p;
        return rest;
      }),
    );
  }

  /** Whether another window is filing it now. */
  heldElsewhere(share: PendingShare, now: number): boolean {
    return !!share.filing && share.filing.by !== this.window && share.filing.until > now;
  }

  /** Filed, or let go: forgotten, and its stashed words with it. */
  done(key: string): void {
    const pending = this.current();
    const gone = pending.find((p) => p.key === key);
    this.save(pending.filter((p) => p.key !== key));
    if (gone?.stash) {
      this.words.remove(gone.stash).catch((err) => console.warn('share words kept', err));
    }
  }

  /**
   * The shares as stored now, another window's changes included; held
   * in memory instead while the device will not keep them.
   */
  private current(): PendingShare[] {
    if (!this.kept()) return this.pending();
    return this.stored() ?? [];
  }

  private stored(): PendingShare[] | undefined {
    const list = this.read<PendingShare[]>(PENDING_SHARES_KEY);
    return Array.isArray(list) ? list : undefined;
  }

  private save(shares: PendingShare[]): void {
    this.pending.set(shares);
    this.kept.set(
      !!this.storage &&
        (shares.length ? this.write(PENDING_SHARES_KEY, shares) : this.remove(PENDING_SHARES_KEY)),
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
