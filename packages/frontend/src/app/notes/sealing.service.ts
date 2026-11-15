import {
  DestroyRef,
  Injectable,
  InjectionToken,
  type Signal,
  effect,
  inject,
  signal,
} from '@angular/core';
import { bytesToBase64, keyCheckProof, paths } from '@mossgoblin/schema';
import { httpsCallable } from 'firebase/functions';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ONLINE, RANDOM_BYTES } from '../platform/platform';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { NoteKeyService } from './note-key.service';

/**
 * The parts of the server that open notes, each run as its own account
 * on the Worker's allowlist, each with its own check callable: the
 * default compute account (MCP, History and merges, suggestions, put
 * back), `goblin-titles` (titles, the recipe importers) and
 * `goblin-runner` (the assistant's runs).
 */
export const SERVER_PARTS = ['main', 'titles', 'runner'] as const;
export type ServerPart = (typeof SERVER_PARTS)[number];

/** Each part's check callable (packages/functions/src/note-keys/check.ts). */
export const KEY_CHECK_CALLABLES: Record<ServerPart, string> = {
  main: 'checkNoteKey',
  titles: 'checkNoteKeyTitles',
  runner: 'checkNoteKeyRunner',
};

/** The functions' half of the check, one part at a time, as a seam for unit specs. */
export interface KeyCheckApi {
  check(part: ServerPart, nonce: string): Promise<{ v: number; proof: string }>;
}

export const KEY_CHECK_API = new InjectionToken<KeyCheckApi>('key-check-api', {
  providedIn: 'root',
  factory: () => {
    const fb = inject(FIREBASE);
    return {
      check: async (part, nonce) =>
        (
          await httpsCallable<{ nonce: string }, { v: number; proof: string }>(
            fb.functions,
            KEY_CHECK_CALLABLES[part],
          )({ nonce })
        ).data,
    };
  },
});

/**
 * How the check before sealing is switched on went: `ok`, this device
 * and every part of the server hold the one key; `offline`, it needs a
 * connection; `device`, this device could not get its key; `server`,
 * some parts could not get it (`failed`, each with why) or were given
 * another key (`mismatched`).
 */
export type SealCheck =
  | { result: 'ok' }
  | { result: 'offline' }
  | { result: 'device'; why: string }
  | {
      result: 'server';
      failed: { part: ServerPart; why: string }[];
      mismatched: ServerPart[];
    };

/** What the writers need of the switch: whether it is on now, and whether it is known yet. */
export interface NoteSealing {
  readonly on: Signal<boolean>;
  /**
   * The setting has been heard at least once since sign-in, from the
   * cache or the server: until then `on` is only a default.
   */
  readonly known: Signal<boolean>;
}

/** The switch the note writers go by; SealingService unless a spec gives its own. */
export const NOTE_SEALING = new InjectionToken<NoteSealing>('note-sealing', {
  providedIn: 'root',
  factory: () => inject(SealingService),
});

/**
 * The gardener's switch that seals note text (note encryption,
 * 2026-11-15; DESIGN.md, "Note encryption"), `sealNotes` in
 * `settings/assistant`, shared by devices and read by the functions.
 * Written as the assistant's other switches are, through the cache and
 * kept on the device until acknowledged (SETTINGS_API, #224).
 *
 * Turning it on first checks, end to end, that this device can get its
 * key from the Worker and that every part of the server, each as its
 * own account, can get the same key its own way (`checkNoteKey`,
 * `checkNoteKeyTitles`, `checkNoteKeyRunner`): each proves the key it
 * holds by a digest of a fresh nonce, never the key. Unless all three
 * match the switch stays off, and the check says which side failed. Turning it off is a
 * write alone: writers keep the form they find again, and nothing is
 * unsealed.
 */
@Injectable({ providedIn: 'root' })
export class SealingService implements NoteSealing {
  private readonly fb = inject(FIREBASE);
  private readonly settings = inject(SETTINGS_API);
  private readonly auth = inject(AuthService);
  private readonly keys = inject(NoteKeyService);
  private readonly api = inject(KEY_CHECK_API);
  private readonly online = inject(ONLINE);
  private readonly random = inject(RANDOM_BYTES);

  private readonly stored = signal(false);
  /** Whether sealing is on, as `settings/assistant` says; off until read. */
  readonly on = this.stored.asReadonly();
  private readonly heard = signal(false);
  readonly known = this.heard.asReadonly();
  private uid?: string;
  private stop?: () => void;
  private read = false;
  /** Writes of the switch the server has not acknowledged yet. */
  private unacked = 0;

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.read = false;
      this.stored.set(false);
      this.heard.set(false);
      if (!uid) return;
      this.stop = this.settings.listen(
        this.fb.db,
        paths.assistant(uid),
        (data, _fromCache, local) => {
          // As KeysService does (#224): a snapshot heard while this
          // device's own write is unacknowledged, or a late echo of it,
          // is no newer than what is showing.
          if (this.unacked > 0 || (local && this.read)) return;
          this.read = true;
          this.stored.set(data?.['sealNotes'] === true);
          this.heard.set(true);
        },
        (err) => console.error('sealing setting listener', err),
      );
    });
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  /**
   * The check, end to end: this device's key from `/api/note-key`, and
   * the functions' from the Worker's `/api/note-key/for`, proved the
   * same by a digest of a fresh nonce.
   */
  async check(): Promise<SealCheck> {
    const uid = this.auth.user()?.uid;
    if (!this.online()) return { result: 'offline' };
    let key;
    try {
      key = await this.keys.fetchNow();
    } catch (err) {
      return { result: 'device', why: err instanceof Error ? err.message : String(err) };
    }
    if (!uid) return { result: 'device', why: 'not signed in' };
    const bytes = new Uint8Array(24);
    this.random(bytes);
    const nonce = bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const expected = keyCheckProof(key, uid, nonce);
    // Every part asked at once, with the one nonce; each proof compared.
    type Answer = { part: ServerPart; matched: boolean } | { part: ServerPart; why: string };
    const answers = await Promise.all(
      SERVER_PARTS.map(async (part): Promise<Answer> => {
        try {
          const { proof } = await this.api.check(part, nonce);
          return { part, matched: proof === expected };
        } catch (err) {
          return { part, why: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    const failed = answers.flatMap((a) => ('why' in a ? [{ part: a.part, why: a.why }] : []));
    const mismatched = answers.flatMap((a) => ('matched' in a && !a.matched ? [a.part] : []));
    return failed.length || mismatched.length
      ? { result: 'server', failed, mismatched }
      : { result: 'ok' };
  }

  /** Runs the check, and turns sealing on only when it passes. */
  async turnOn(): Promise<SealCheck> {
    const outcome = await this.check();
    if (outcome.result === 'ok') this.write(true);
    return outcome;
  }

  /** Turns sealing off: new text keeps the form it finds; nothing is unsealed. */
  turnOff(): void {
    this.write(false);
  }

  private write(on: boolean): void {
    if (!this.uid) return;
    this.stored.set(on);
    this.unacked++;
    this.settings
      .set(
        this.fb.db,
        paths.assistant(this.uid),
        { sealNotes: on, updatedAt: this.settings.now() },
        true,
      )
      .catch((err) => console.error('sealing setting write', err))
      .finally(() => this.unacked--);
  }
}
