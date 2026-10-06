import { Injectable, InjectionToken, effect, inject, signal, untracked } from '@angular/core';
import { paths } from '@goblin/schema';
import { type Firestore, deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { PRODUCTION_VAPID_KEY } from '../../environments/firebase-config';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NotesService } from '../notes/notes.service';
import { LocalStore } from '../platform/local-store';

/**
 * Where this device stands on notifications:
 * - `checking` until the user and the browser are known;
 * - `unsupported` (no web push here) or `unconfigured` (no Web Push key);
 * - `off`, `blocked` (the browser said no), or `on` (registered);
 * - `working` during a change, `error` when one failed.
 */
export type PushState =
  'checking' | 'unsupported' | 'unconfigured' | 'off' | 'blocked' | 'on' | 'working' | 'error';

/** The browser, FCM and Firestore calls, as a seam for unit specs. */
export interface PushApi {
  supported(): Promise<boolean>;
  /** False until the project's Web Push key is set. */
  readonly configured: boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** This device's push token; throws when FCM will not give one. */
  token(): Promise<string>;
  deleteToken(): Promise<void>;
  save(db: Firestore, path: string, data: Record<string, unknown>): Promise<void>;
  remove(db: Firestore, path: string): Promise<void>;
  serverTime(): unknown;
}

/** Remembers that this device asked for notifications. */
export const PUSH_KEY = 'goblin.push';

/** How long to wait for the app's service worker before giving up. */
const SW_TIMEOUT_MS = 30_000;

export const PUSH_API = new InjectionToken<PushApi>('push-api', {
  providedIn: 'root',
  factory: () => {
    const fb = inject(FIREBASE);
    const browser = {
      permission: () => Notification.permission,
      requestPermission: () => Notification.requestPermission(),
      save: (db: Firestore, path: string, data: Record<string, unknown>) =>
        setDoc(doc(db, path), data),
      remove: (db: Firestore, path: string) => deleteDoc(doc(db, path)),
      serverTime: () => serverTimestamp(),
    };
    if (fb.usingEmulators) {
      // There is no FCM emulator: on localhost the device registers with
      // a stand-in token, so the flow can be driven end to end.
      return {
        ...browser,
        configured: true,
        supported: async () => 'Notification' in globalThis,
        token: async () => 'emulator-token',
        deleteToken: async () => undefined,
      };
    }
    return {
      ...browser,
      configured: PRODUCTION_VAPID_KEY !== null,
      supported: async () => {
        if (!('Notification' in globalThis) || !('serviceWorker' in navigator)) return false;
        const { isSupported } = await import('firebase/messaging');
        return isSupported();
      },
      token: async () => {
        const { getMessaging, getToken } = await import('firebase/messaging');
        // The Angular service worker receives the pushes and shows them
        // (DESIGN.md, Push), so FCM subscribes through its registration.
        const registration = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('the app is not installed yet')), SW_TIMEOUT_MS),
          ),
        ]);
        return getToken(getMessaging(fb.app), {
          vapidKey: PRODUCTION_VAPID_KEY ?? undefined,
          serviceWorkerRegistration: registration,
        });
      },
      deleteToken: async () => {
        const { getMessaging, deleteToken } = await import('firebase/messaging');
        await deleteToken(getMessaging(fb.app));
      },
    };
  },
});

/**
 * This device's notifications: turning them on asks the browser, gets an
 * FCM token and records it in `devices/{deviceId}`, which sendDuePush
 * reads. Once on, every sign-in refreshes the token, since FCM rotates
 * them.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly api = inject(PUSH_API);
  private readonly fb = inject(FIREBASE);
  private readonly auth = inject(AuthService);
  private readonly notes = inject(NotesService);
  private readonly store = inject(LocalStore);

  readonly state = signal<PushState>('checking');
  readonly error = signal('');

  private uid?: string;

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      untracked(() => {
        if (uid === this.uid) return;
        this.uid = uid;
        if (uid) void this.refresh();
        else this.state.set('checking');
      });
    });
  }

  /** Asks for permission if needed and registers this device. */
  async enable(): Promise<void> {
    if (!this.uid) return;
    this.state.set('working');
    try {
      const permission = await this.api.requestPermission();
      if (permission !== 'granted') {
        this.state.set(permission === 'denied' ? 'blocked' : 'off');
        return;
      }
      await this.register();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Stops pushes to this device. */
  async disable(): Promise<void> {
    if (!this.uid) return;
    this.state.set('working');
    this.store.set(PUSH_KEY, false);
    this.api.remove(this.fb.db, this.devicePath()).catch(report);
    try {
      await this.api.deleteToken();
    } catch (err) {
      // The device record is gone, so nothing is sent either way.
      report(err);
    }
    this.state.set('off');
  }

  /**
   * Before sign-out: a signed-out (or shared) browser must stop getting
   * reminder text, so a device that was on is turned off. Deleting the
   * FCM token is what guarantees it; the device record is removed too,
   * and sendDuePush drops it anyway once FCM calls the token gone.
   */
  async beforeSignOut(): Promise<void> {
    if (this.store.get<boolean>(PUSH_KEY) === true || this.state() === 'on') {
      await this.disable();
    }
  }

  private async refresh(): Promise<void> {
    try {
      if (!(await this.api.supported())) return this.state.set('unsupported');
      if (!this.api.configured) return this.state.set('unconfigured');
      const permission = this.api.permission();
      if (permission === 'denied') return this.state.set('blocked');
      if (permission === 'granted' && this.store.get<boolean>(PUSH_KEY) === true) {
        return await this.register();
      }
      this.state.set('off');
    } catch (err) {
      this.fail(err);
    }
  }

  private async register(): Promise<void> {
    const token = await this.api.token();
    // Through the persistent cache like every write: lands at once, syncs later.
    this.api
      .save(this.fb.db, this.devicePath(), { token, updatedAt: this.api.serverTime() })
      .catch(report);
    this.store.set(PUSH_KEY, true);
    this.error.set('');
    this.state.set('on');
  }

  private devicePath(): string {
    return `${paths.devices(this.uid!)}/${this.notes.deviceId()}`;
  }

  private fail(err: unknown): void {
    report(err);
    this.error.set(err instanceof Error ? err.message : String(err));
    this.state.set('error');
  }
}

function report(err: unknown): void {
  console.error('push', err);
}
