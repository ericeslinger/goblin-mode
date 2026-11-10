import { Injectable, computed, inject, signal, untracked } from '@angular/core';
import { AuthService } from '../auth.service';
import { NOW } from '../platform/platform';
import { LocalStore } from '../platform/local-store';
import { ItemsService } from '../reader/items.service';
import { episodeState } from './episodes';

/** Where the last visit to Latest is kept on this device, millis by account (#251). */
export const LATEST_SEEN_KEY = 'goblin.podcasts.latestSeen';

/**
 * What is new in Podcasts since the last visit to Latest (#251), for
 * Right Now's line beside the Reader's (#173). The mark is this
 * device's, in local storage by account, not a stored field: a visit on
 * the phone does not clear the laptop's line. An episode counts while
 * it is New (not heard, no place kept) and was published after the
 * mark; with no mark yet, every New one counts, as a folder never
 * opened does in the Reader.
 */
@Injectable({ providedIn: 'root' })
export class PodcastsSeen {
  private readonly store = inject(LocalStore);
  private readonly items = inject(ItemsService);
  private readonly auth = inject(AuthService);
  private readonly now = inject(NOW);
  private readonly marks = signal<Record<string, number>>(this.stored());

  /** When this account last saw Latest on this device, millis, if ever. */
  readonly seenAt = computed(() => {
    const uid = this.auth.user()?.uid;
    return uid ? this.marks()[uid] : undefined;
  });

  /** How many New episodes are newer than the last visit to Latest. */
  readonly fresh = computed(() => {
    const at = this.seenAt();
    return this.items
      .episodes()
      .filter((e) => episodeState(e) === 'new' && (at === undefined || e.published > at)).length;
  });

  /**
   * Latest seen now: the mark is now, or the newest episode if a
   * feed's clock puts it later, as the Reader's folders are (#173).
   * Nothing is written while nothing is newer than the mark.
   */
  markSeen(): void {
    untracked(() => {
      const uid = this.auth.user()?.uid;
      const newest = this.items.episodes()[0]?.published;
      if (!uid || newest === undefined) return;
      const at = this.seenAt();
      if (at !== undefined && newest <= at) return;
      const marks = { ...this.marks(), [uid]: Math.max(this.now(), newest) };
      this.marks.set(marks);
      this.store.set(LATEST_SEEN_KEY, marks);
    });
  }

  private stored(): Record<string, number> {
    const raw = this.store.get<unknown>(LATEST_SEEN_KEY);
    const out: Record<string, number> = {};
    if (raw && typeof raw === 'object') {
      for (const [uid, at] of Object.entries(raw)) {
        if (typeof at === 'number' && Number.isFinite(at)) out[uid] = at;
      }
    }
    return out;
  }
}
