import { Injectable, signal } from '@angular/core';
import type { Mode } from '@mossgoblin/editor';

const KEY = 'goblin.editorMode';
const VIEWING_KEY = 'goblin.viewing';
/** Enough for every list Eric shops or works from; the oldest drop off. */
export const VIEWING_MAX = 50;

/**
 * Live preview or source, remembered app-wide on this device (Eric,
 * 2026-10-06). Storage can be unavailable (private mode); then the
 * choice simply lasts for the session.
 */
@Injectable({ providedIn: 'root' })
export class EditorModeService {
  readonly mode = signal<Mode>(this.read());
  /**
   * Notes left in viewing (2026-10-17), oldest first. Remembered per
   * note on the device, so a shopping list opens ready to tick while a
   * new note always opens ready to type.
   */
  private readonly viewingIds = signal<string[]>(this.readViewing());

  viewing(id: string): boolean {
    return this.viewingIds().includes(id);
  }

  setViewing(id: string, viewing: boolean): void {
    const others = this.viewingIds().filter((v) => v !== id);
    const ids = viewing ? [...others, id].slice(-VIEWING_MAX) : others;
    this.viewingIds.set(ids);
    try {
      localStorage.setItem(VIEWING_KEY, JSON.stringify(ids));
    } catch {
      // Not persisted; fine.
    }
  }

  set(mode: Mode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      // Not persisted; fine.
    }
  }

  toggle(): void {
    this.set(this.mode() === 'live' ? 'source' : 'live');
  }

  private readViewing(): string[] {
    try {
      const ids: unknown = JSON.parse(localStorage.getItem(VIEWING_KEY) ?? '[]');
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  private read(): Mode {
    try {
      return localStorage.getItem(KEY) === 'source' ? 'source' : 'live';
    } catch {
      return 'live';
    }
  }
}
