import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { KeyWaitLine } from './notes/key-wait-notice';
import { MiniPlayer } from './reader/mini-player';
import { PlayerPresence } from './reader/player-presence';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, MiniPlayer, KeyWaitLine],
  // The mini-player (#179), deferred: the Reader loads only once an episode is in hand.
  // A write refused for want of the note key says so on any page (2026-11-15).
  template: `<app-key-wait-line />
    <router-outlet />
    @if (presence.id()) {
      @defer {
        <app-mini-player />
      }
    }`,
})
export class App {
  protected readonly presence = inject(PlayerPresence);
}
