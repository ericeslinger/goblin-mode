import { Injectable, inject } from '@angular/core';
import { STORAGE } from './platform';

/**
 * Small JSON values kept on this device. Every call tolerates storage
 * being missing, full or corrupt: the app works, it just forgets.
 */
@Injectable({ providedIn: 'root' })
export class LocalStore {
  private readonly storage = inject(STORAGE);

  get<T>(key: string): T | undefined {
    try {
      const raw = this.storage?.getItem(key);
      return raw == null ? undefined : (JSON.parse(raw) as T);
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    try {
      this.storage?.setItem(key, JSON.stringify(value));
    } catch {
      // Not persisted; fine.
    }
  }

  remove(key: string): void {
    try {
      this.storage?.removeItem(key);
    } catch {
      // Nothing to do.
    }
  }
}
