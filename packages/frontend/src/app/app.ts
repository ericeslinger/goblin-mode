import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MiniPlayer } from './reader/mini-player';
import { PlayerPresence } from './reader/player-presence';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, MiniPlayer],
  // The mini-player (#179), deferred: the Reader loads only once an episode is in hand.
  template: `<router-outlet />
    @if (presence.id()) {
      @defer {
        <app-mini-player />
      }
    }`,
})
export class App {
  protected readonly presence = inject(PlayerPresence);
}
