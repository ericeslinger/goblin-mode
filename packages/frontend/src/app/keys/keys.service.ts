import { DestroyRef, Injectable, InjectionToken, effect, inject, signal } from '@angular/core';
import { type KeyMeta, type KeySettings, type Provider, paths } from '@mossgoblin/schema';
import { httpsCallable } from 'firebase/functions';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { SETTINGS_API } from '../theme/theme-sync.service';

/** The calls to the keys functions (onCall), as a seam for unit specs. */
export interface KeysApi {
  save(provider: Provider, key: string): Promise<{ masked: string }>;
  remove(provider: Provider): Promise<void>;
}

export const KEYS_API = new InjectionToken<KeysApi>('keys-api', {
  providedIn: 'root',
  factory: () => {
    const fb = inject(FIREBASE);
    return {
      save: async (provider, key) =>
        (
          await httpsCallable<unknown, { masked: string }>(
            fb.functions,
            'saveKey',
          )({ provider, key })
        ).data,
      remove: async (provider) => {
        await httpsCallable(fb.functions, 'removeKey')({ provider });
      },
    };
  },
});

/** A kept key as the app shows it; times in milliseconds. */
export interface KeyRecord {
  masked: string;
  updatedAt?: number;
  lastUsedAt?: number;
  broken: boolean;
}

const millis = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.();

function read(data: Record<string, unknown>): Partial<Record<Provider, KeyRecord>> {
  const out: Partial<Record<Provider, KeyRecord>> = {};
  for (const provider of ['anthropic', 'gemini', 'openrouter'] as const) {
    const meta = data[provider] as Partial<KeyMeta> | undefined;
    if (typeof meta?.masked !== 'string') continue;
    out[provider] = {
      masked: meta.masked,
      updatedAt: millis(meta.updatedAt),
      lastUsedAt: millis(meta.lastUsedAt),
      broken: meta.broken === true,
    };
  }
  return out;
}

/** Never gardened on arrival (#229): template ids and tags. */
export interface ArrivalSkip {
  templates: string[];
  tags: string[];
}

const NO_SKIP: ArrivalSkip = { templates: [], tags: [] };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Tags as kept: trimmed, without a leading #, each once, none empty. */
function tagsOf(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().replace(/^#/, '').trim()).filter(Boolean))];
}

function skipOf(v: unknown): ArrivalSkip {
  if (typeof v !== 'object' || v === null) return NO_SKIP;
  const o = v as Record<string, unknown>;
  return { templates: strings(o['templates']), tags: strings(o['tags']) };
}

/**
 * The gardener's own provider keys (#144): what the app may know of
 * them, from `settings/keys`, which the functions write. Saving and
 * removing go through callables, so they need the network, unlike every
 * note write: Settings says so when a call fails.
 */
@Injectable({ providedIn: 'root' })
export class KeysService {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(KEYS_API);
  private readonly settings = inject(SETTINGS_API);
  private readonly auth = inject(AuthService);
  private uid?: string;
  private stop?: () => void;

  /** The kept keys, by provider; undefined until read. */
  readonly keys = signal<Partial<Record<Provider, KeyRecord>> | undefined>(undefined);
  /** Garden new notes on arrival (#214), from `settings/assistant`; off until read. */
  readonly onArrival = signal(false);
  /** Never gardened on arrival (#229): template ids and tags, from `settings/assistant`. */
  readonly arrivalSkip = signal<ArrivalSkip>(NO_SKIP);
  private stopAssistant?: () => void;

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stopAssistant?.();
      this.stop = this.stopAssistant = undefined;
      this.uid = uid;
      this.keys.set(undefined);
      this.onArrival.set(false);
      this.arrivalSkip.set(NO_SKIP);
      if (!uid) return;
      this.stop = this.settings.listen(
        this.fb.db,
        paths.keys(uid),
        (data) => this.keys.set(data ? read(data as KeySettings) : {}),
        (err) => console.error('keys listener', err),
      );
      this.stopAssistant = this.settings.listen(
        this.fb.db,
        paths.assistant(uid),
        (data) => {
          this.onArrival.set(data?.['gardenOnArrival'] === true);
          this.arrivalSkip.set(skipOf(data?.['arrivalSkip']));
        },
        (err) => console.error('assistant settings listener', err),
      );
    });
    inject(DestroyRef).onDestroy(() => {
      this.stop?.();
      this.stopAssistant?.();
    });
  }

  /**
   * Turns Garden new notes on arrival on or off (#214). A settings
   * write like the theme's: through the cache, never awaited, so it
   * works offline; the functions read it when a note settles.
   */
  setOnArrival(on: boolean): void {
    if (!this.uid) return;
    this.onArrival.set(on);
    this.writeAssistant({ gardenOnArrival: on });
  }

  /**
   * What is never gardened on arrival (#229): notes made from these
   * templates, and notes with these tags. Written as the switch is.
   */
  setArrivalSkip(skip: ArrivalSkip): void {
    if (!this.uid) return;
    const kept = { templates: [...new Set(skip.templates)], tags: tagsOf(skip.tags) };
    this.arrivalSkip.set(kept);
    this.writeAssistant({ arrivalSkip: kept });
  }

  /**
   * A merge write of the fields given, so the switch and the skip list
   * never overwrite each other: flipped offline, or before the doc's
   * first snapshot, the switch's write would otherwise replace the doc
   * with an empty skip list (review on #232).
   */
  private writeAssistant(fields: Record<string, unknown>): void {
    if (!this.uid) return;
    this.settings
      .set(
        this.fb.db,
        paths.assistant(this.uid),
        { ...fields, updatedAt: this.settings.now() },
        true,
      )
      .catch((err) => console.error('assistant settings write', err));
  }

  /** Keeps a pasted key; the masked record arrives through the listener. */
  save(provider: Provider, key: string): Promise<{ masked: string }> {
    return this.api.save(provider, key);
  }

  remove(provider: Provider): Promise<void> {
    return this.api.remove(provider);
  }
}
