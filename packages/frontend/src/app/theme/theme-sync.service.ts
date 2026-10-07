import { DestroyRef, Injectable, InjectionToken, effect, inject, untracked } from '@angular/core';
import { Settings, paths } from '@mossgoblin/schema';
import { type Firestore, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
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
  set(db: Firestore, path: string, data: Record<string, unknown>): Promise<void>;
  /** The server's time, as the write's updatedAt. */
  now(): unknown;
}

export const SETTINGS_API = new InjectionToken<SettingsApi>('settings-api', {
  providedIn: 'root',
  factory: () => ({
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
    set: (db, path, data) => setDoc(doc(db, path), data),
    now: () => serverTimestamp(),
  }),
});

/**
 * Keeps the theme in the gardener's settings doc, so it follows them
 * across devices (#24). Signed in, the doc wins: a choice made on
 * another device is adopted here. A choice made here is written
 * through the persistent cache and never awaited, so it works offline.
 * A device that chose before there was a doc uploads its choice, and a
 * choice made while sign-in is still being restored is written once
 * the gardener is known, rather than lost to the older doc.
 */
@Injectable({ providedIn: 'root' })
export class ThemeSync {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(SETTINGS_API);
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);

  private uid?: string;
  private stop?: () => void;
  private seen = untracked(() => this.theme.chosen());
  /** A choice made before the gardener was known, to write on arrival. */
  private pending = false;

  constructor() {
    effect(() => {
      const user = this.auth.user();
      // Signed out: a choice held from sign-in restore is no longer anyone's.
      if (user === null) this.pending = false;
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
    if (this.pending) {
      this.pending = false;
      this.write();
      return;
    }
    if (data === undefined) {
      // Only the server can say there is no doc: an empty cache (a new
      // device, offline) must not overwrite another device's choice.
      if (!fromCache && this.theme.hasStoredChoice()) this.write();
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
    const data = { theme: this.theme.theme(), mode: this.theme.mode(), updatedAt: this.api.now() };
    this.api.set(this.fb.db, paths.settings(this.uid), data).catch((err) => {
      console.error('settings write failed', err);
    });
  }
}
