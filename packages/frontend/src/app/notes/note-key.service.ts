import {
  DestroyRef,
  Injectable,
  InjectionToken,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  type DataKey,
  bytesToBase64,
  exportDataKey,
  importDataKey,
  noteKeyFromWire,
} from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { ONLINE, STORAGE } from '../platform/platform';

/** The Worker's route for the signed-in gardener's own key (note encryption step 2). */
export const NOTE_KEY_PATH = '/api/note-key';
/** This device's copy of a gardener's key is kept under this, then the uid. */
export const NOTE_KEY_PREFIX = 'goblin.noteKey.';

/** This device could not get its key: offline, signed out, or the service refused. */
export class NoteKeyUnavailable extends Error {
  override readonly name = 'NoteKeyUnavailable';
}

/** The network call the service makes, as a seam for unit specs. */
export interface NoteKeyApi {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export const NOTE_KEY_API = new InjectionToken<NoteKeyApi>('note-key-api', {
  providedIn: 'root',
  factory: () => ({ fetch: (url, init) => fetch(url, init) }),
});

/**
 * The signed-in gardener's note data key (note encryption step 2;
 * DESIGN.md, "Note encryption", Key custody), held for the notes it
 * opens and, with the gardener's switch on (2026-11-15), seals.
 *
 * Once a gardener is signed in and online it asks the Worker once a
 * load, with their ID token, and keeps the key in memory and on this
 * device (keyed by uid), so a later start offline has it at once; a
 * failed ask is tried again when the device comes back online, or on
 * the next load. Signing out forgets every device copy. It never
 * blocks anything and never throws: without a key, `key()` is simply
 * undefined, and failures go to the console alone. `fetchNow`, for the
 * check before sealing is switched on (2026-11-15), asks at once and
 * says when it cannot.
 */
@Injectable({ providedIn: 'root' })
export class NoteKeyService {
  private readonly api = inject(NOTE_KEY_API);
  private readonly auth = inject(AuthService);
  private readonly storage = inject(STORAGE);
  private readonly online = inject(ONLINE);

  private readonly held = signal<DataKey | undefined>(undefined);
  /** The gardener's data key, or undefined while there is none to hand. */
  readonly key = this.held.asReadonly();

  private uid?: string;
  /** The uid whose key this load has fetched, or is fetching. */
  private asked?: string;

  constructor() {
    effect(() => {
      const user = this.auth.user();
      untracked(() => this.follow(user));
    });
    const back = () => void this.ask();
    globalThis.addEventListener?.('online', back);
    inject(DestroyRef).onDestroy(() => globalThis.removeEventListener?.('online', back));
  }

  private follow(user: User | null | undefined): void {
    // Still restoring the session: wait, and keep what is held.
    if (user === undefined) return;
    if (user === null) {
      this.uid = this.asked = undefined;
      this.held.set(undefined);
      this.forgetAll();
      return;
    }
    if (user.uid === this.uid) return;
    this.uid = user.uid;
    this.asked = undefined;
    this.held.set(this.fromDevice(user.uid));
    void this.ask();
  }

  /** Asks the Worker for the signed-in gardener's key, once a load. */
  private async ask(): Promise<void> {
    const user = this.auth.user();
    if (!user || user.uid !== this.uid || this.asked === user.uid || !this.online()) return;
    const uid = user.uid;
    this.asked = uid;
    try {
      await this.fetchKey(user);
    } catch (err) {
      if (this.asked === uid) this.asked = undefined;
      console.warn('note key not fetched; trying again when back online', String(err));
    }
  }

  /**
   * Asks the Worker for the signed-in gardener's key now, whatever this
   * load asked before, and holds it as `ask` does: the check before
   * sealing is switched on (2026-11-15), which must show this device can
   * get it. Throws `NoteKeyUnavailable` when it cannot; never the key's
   * bytes in a message.
   */
  async fetchNow(): Promise<DataKey> {
    const user = this.auth.user();
    if (!user || user.uid !== this.uid) throw new NoteKeyUnavailable('not signed in');
    if (!this.online()) throw new NoteKeyUnavailable('offline');
    try {
      return await this.fetchKey(user);
    } catch (err) {
      if (err instanceof NoteKeyUnavailable) throw err;
      throw new NoteKeyUnavailable(err instanceof Error ? err.message : String(err));
    }
  }

  private async fetchKey(user: User): Promise<DataKey> {
    const uid = user.uid;
    const token = await user.getIdToken();
    const res = await this.api.fetch(NOTE_KEY_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) throw new NoteKeyUnavailable(`the note key service answered ${res.status}`);
    const wire = noteKeyFromWire(await res.json());
    if (!wire) throw new NoteKeyUnavailable('the note key service answered with no key');
    // Signed out, or someone else, while it was asked: keep nothing.
    if (this.auth.user()?.uid !== uid || this.uid !== uid) {
      throw new NoteKeyUnavailable('signed out while it was asked');
    }
    this.toDevice(uid, wire.v, wire.bytes);
    const held = this.held();
    if (!held || bytesToBase64(exportDataKey(held)) !== bytesToBase64(wire.bytes)) {
      this.held.set(importDataKey(wire.bytes));
    }
    return this.held()!;
  }

  private fromDevice(uid: string): DataKey | undefined {
    try {
      const raw = this.storage?.getItem(NOTE_KEY_PREFIX + uid);
      const wire = raw ? noteKeyFromWire(JSON.parse(raw)) : undefined;
      return wire ? importDataKey(wire.bytes) : undefined;
    } catch {
      return undefined;
    }
  }

  private toDevice(uid: string, v: number, bytes: Uint8Array): void {
    try {
      this.storage?.setItem(
        NOTE_KEY_PREFIX + uid,
        JSON.stringify({ v, key: bytesToBase64(bytes) }),
      );
    } catch {
      // Not kept on this device; fetched again next time.
    }
  }

  /** Every gardener's device copy, not only the last one's. */
  private forgetAll(): void {
    try {
      const storage = this.storage;
      if (!storage) return;
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (name?.startsWith(NOTE_KEY_PREFIX)) keys.push(name);
      }
      for (const name of keys) storage.removeItem(name);
    } catch {
      // Nothing to do.
    }
  }
}
