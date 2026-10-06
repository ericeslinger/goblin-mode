import { Injectable, signal } from '@angular/core';
import type { Mode } from '@goblin/editor';

const KEY = 'goblin.editorMode';

/**
 * Live preview or source, remembered app-wide on this device (Eric,
 * 2026-10-06). Storage can be unavailable (private mode); then the
 * choice simply lasts for the session.
 */
@Injectable({ providedIn: 'root' })
export class EditorModeService {
  readonly mode = signal<Mode>(this.read());

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

  private read(): Mode {
    try {
      return localStorage.getItem(KEY) === 'source' ? 'source' : 'live';
    } catch {
      return 'live';
    }
  }
}
