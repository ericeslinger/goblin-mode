import { DestroyRef, Injectable, InjectionToken, effect, inject, untracked } from '@angular/core';
import { Settings, StartOn, paths } from '@mossgoblin/schema';
import { type Firestore, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { STORAGE } from '../platform/platform';
import { HomeTilesService } from '../home/home-tiles';
import { StartOnService } from '../home/start-on';
import { keepUntilAcknowledged } from './kept-settings';
import { ThemeService } from './theme.service';

/** The Firestore calls ThemeSync makes, as a seam for unit specs. */
export interface SettingsApi {
  /**
   * The settings doc as it stands, or undefined when there is none yet;
   * `fromCache` says the answer has not been confirmed by the server, and
   * `local` that it carries this device's own writes not yet sent.
   */
  listen(
    db: Firestore,
    path: string,
    next: (data: Record<string, unknown> | undefined, fromCache: boolean, local: boolean) => void,
    error: (err: unknown) => void,
  ): () => void;
  /** Writes the doc; with `merge`, only the fields given, keeping the rest. */
  set(db: Firestore, path: string, data: Record<string, unknown>, merge?: boolean): Promise<void>;
  /** The server's time, as the write's updatedAt. */
  now(): unknown;
}

export const SETTINGS_API = new InjectionToken<SettingsApi>('settings-api', {
  providedIn: 'root',
  // Each write is kept on the device until acknowledged (#224), so a
  // reload in the moment before the cache takes it does not lose it.
  factory: () =>
    keepUntilAcknowledged(
      {
        listen: (db, path, next, error) =>
          onSnapshot(
            doc(db, path),
            // Metadata changes too, so a cached "no doc" is followed by the
            // server's answer.
            { includeMetadataChanges: true },
            (snap) =>
              next(
                snap.exists() ? snap.data() : undefined,
                snap.metadata.fromCache,
                snap.metadata.hasPendingWrites,
              ),
            error,
          ),
        set: (db, path, data, merge) => setDoc(doc(db, path), data, { merge: merge === true }),
        now: () => serverTimestamp(),
      },
      inject(STORAGE),
    ),
});

/**
 * Keeps the theme in the gardener's settings doc, so it follows them
 * across devices (#24). Signed in, the doc wins: a choice made on
 * another device is adopted here. A choice made here is written
 * through the persistent cache and never awaited, so it works offline.
 * A device that chose before there was a doc uploads its choice, and a
 * choice made while sign-in is still being restored is written once
 * the gardener is known, rather than lost to the older doc. Start on
 * (#219) rides in the same doc and is kept the same way: the doc is
 * written whole, so each write carries both. So does Home's
 * arrangement (#222), `homeTiles` and `homeHidden`. A choice the cache
 * had not yet taken when the page reloaded is written again from the
 * device (SETTINGS_API, #224) before the doc is listened to, so the
 * first snapshot is this device's own pending write, which `received`
 * passes over, and the doc that wins after it holds that choice.
 */
@Injectable({ providedIn: 'root' })
export class ThemeSync {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(SETTINGS_API);
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly startOn = inject(StartOnService);
  private readonly tiles = inject(HomeTilesService);

  private uid?: string;
  private stop?: () => void;
  private seen = untracked(() => this.theme.chosen());
  private seenStart = untracked(() => this.startOn.chosen());
  private seenTiles = untracked(() => this.tiles.chosen());
  /** A choice made before the gardener was known, to write on arrival. */
  private pending = false;
  /** That choice included Start on, so the doc's must not replace it. */
  private pendingStart = false;
  /** That choice included Home's tiles, likewise. */
  private pendingTiles = false;

  constructor() {
    effect(() => {
      const user = this.auth.user();
      // Signed out: a choice held from sign-in restore is no longer anyone's.
      if (user === null) this.pending = this.pendingStart = this.pendingTiles = false;
      const uid = user?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      if (!uid) return;
      this.stop = this.api.listen(
        this.fb.db,
        paths.settings(uid),
        (data, fromCache, local) => this.received(data, fromCache, local),
        (err) => console.error('settings listener', err),
      );
    });
    effect(() => {
      const chosen = this.theme.chosen();
      if (chosen === this.seen) return;
      this.seen = chosen;
      untracked(() => this.write());
    });
    effect(() => {
      const chosen = this.startOn.chosen();
      if (chosen === this.seenStart) return;
      this.seenStart = chosen;
      untracked(() => {
        if (!this.uid) this.pendingStart = true;
        this.write();
      });
    });
    effect(() => {
      const chosen = this.tiles.chosen();
      if (chosen === this.seenTiles) return;
      this.seenTiles = chosen;
      untracked(() => {
        if (!this.uid) this.pendingTiles = true;
        this.write();
      });
    });
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  private received(
    data: Record<string, unknown> | undefined,
    fromCache: boolean,
    local = false,
  ): void {
    // The echo of this device's own write: a newer choice may already be
    // showing, and adopting the echo would briefly undo it.
    if (local) return;
    // Start on (#219) first, so a pending theme's write carries it on,
    // unless it was chosen here while sign-in was restoring: that choice
    // is newer than the doc and is what gets written. Absent, as on a
    // doc from before it: this device keeps its own.
    const startOn = StartOn.safeParse(data?.['startOn']);
    if (startOn.success && !(this.pending && this.pendingStart)) {
      this.startOn.adopt(startOn.data);
    }
    // Home's tiles (#222) the same way; a doc with neither list keeps
    // this device's.
    const order = Settings.shape.homeTiles.safeParse(data?.['homeTiles']);
    const hidden = Settings.shape.homeHidden.safeParse(data?.['homeHidden']);
    if (
      order.success &&
      hidden.success &&
      (order.data || hidden.data) &&
      !(this.pending && this.pendingTiles)
    ) {
      this.tiles.adopt({ order: order.data ?? [], hidden: hidden.data ?? [] });
    }
    if (this.pending) {
      this.pending = this.pendingStart = this.pendingTiles = false;
      this.write();
      return;
    }
    if (data === undefined) {
      // Only the server can say there is no doc: an empty cache (a new
      // device, offline) must not overwrite another device's choice.
      if (
        !fromCache &&
        (this.theme.hasStoredChoice() ||
          this.startOn.hasStoredChoice() ||
          this.tiles.hasStoredChoice())
      ) {
        this.write();
      }
      return;
    }
    const parsed = Settings.pick({ theme: true, mode: true }).safeParse(data);
    if (parsed.success) this.theme.adopt(parsed.data.theme, parsed.data.mode);
  }

  private write(): void {
    if (!this.uid) {
      // Restoring sign-in (undefined), not signed out (null).
      this.pending = this.auth.user() === undefined;
      return;
    }
    const data = {
      theme: this.theme.theme(),
      mode: this.theme.mode(),
      // Only once chosen here or read from the doc.
      ...(this.startOn.hasStoredChoice() ? { startOn: this.startOn.choice() } : {}),
      ...(this.tiles.hasStoredChoice()
        ? {
            homeTiles: this.tiles.arrangement().order,
            homeHidden: this.tiles.arrangement().hidden,
          }
        : {}),
      updatedAt: this.api.now(),
    };
    this.api.set(this.fb.db, paths.settings(this.uid), data).catch((err) => {
      console.error('settings write failed', err);
    });
  }
}
