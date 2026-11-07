import { Injectable, inject, signal } from '@angular/core';
import { STORAGE } from '../platform/platform';

const CURRENT_KEY = 'goblin.player.current';

/**
 * Whether an episode is in hand (#179), and which, remembered on the
 * device. Kept apart from the player so the shell can ask without
 * loading the Reader: the mini-player, and the articles' listeners
 * behind it, load only once there is something to play.
 */
@Injectable({ providedIn: 'root' })
export class PlayerPresence {
  private readonly storage = inject(STORAGE);
  /** The item id, or undefined. */
  readonly id = signal<string | undefined>(this.stored());

  set(id: string | undefined): void {
    this.id.set(id);
    try {
      if (id === undefined) this.storage?.removeItem(CURRENT_KEY);
      else this.storage?.setItem(CURRENT_KEY, id);
    } catch {
      // Storage refused: remembered this visit only.
    }
  }

  private stored(): string | undefined {
    try {
      return this.storage?.getItem(CURRENT_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }
}
