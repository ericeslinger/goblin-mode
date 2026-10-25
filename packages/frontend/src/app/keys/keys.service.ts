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

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.keys.set(undefined);
      if (!uid) return;
      this.stop = this.settings.listen(
        this.fb.db,
        paths.keys(uid),
        (data) => this.keys.set(data ? read(data as KeySettings) : {}),
        (err) => console.error('keys listener', err),
      );
    });
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  /** Keeps a pasted key; the masked record arrives through the listener. */
  save(provider: Provider, key: string): Promise<{ masked: string }> {
    return this.api.save(provider, key);
  }

  remove(provider: Provider): Promise<void> {
    return this.api.remove(provider);
  }
}
