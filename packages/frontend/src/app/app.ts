import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { KeyWaitLine } from './notes/key-wait-notice';
import { Rail } from './rail/rail';
import { MiniPlayer } from './reader/mini-player';
import { PlayerPresence } from './reader/player-presence';
import { CommandBox } from './shortcuts/command-box';
import { ShortcutsService } from './shortcuts/shortcuts.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, MiniPlayer, KeyWaitLine, Rail, CommandBox],
  // The desktop rail (#289), drawn once here for every screen from 900 px,
  // first so its Skip to content is the first thing Tab reaches.
  // The mini-player (#179), deferred: the Reader loads only once an episode is in hand.
  // A write refused for want of the note key says so on any page (2026-11-15).
  // The command box (#289, 2026-11-16), a modal dialog until Ctrl K.
  template: `<app-rail />
    <app-key-wait-line />
    <router-outlet />
    @if (presence.id()) {
      @defer {
        <app-mini-player />
      }
    }
    <app-command-box />`,
})
export class App {
  protected readonly presence = inject(PlayerPresence);

  constructor() {
    // The app-wide keys (#289), made here, before any screen, so their
    // document listener runs before the screens' own (the Reader's).
    inject(ShortcutsService);
  }
}
