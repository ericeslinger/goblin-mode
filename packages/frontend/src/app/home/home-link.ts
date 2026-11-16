import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from './icon';
import { NewNoteButton } from './new-note';

/**
 * The leaf (#219): Home, from the top left of every screen, where Back
 * to the start screen used to be. A 44 px target. New note (#272) sits
 * just right of it, so it is wherever the leaf is. Beside the desktop
 * rail (#289, 2026-11-16) the leaf is not drawn: the rail's Home is it.
 */
@Component({
  selector: 'app-home-link',
  imports: [RouterLink, Icon, NewNoteButton],
  template: `<a routerLink="/home" aria-label="Home"><app-icon name="leaf" /></a><app-new-note />`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
    }
    a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      margin: calc(-1 * var(--space-2));
      border-radius: var(--radius-control);
    }
    /* Beside the desktop rail (#289) its Home entry is the way home;
       the leaf gives way, New note staying where it was. */
    :host-context(.has-rail) a {
      display: none;
    }
  `,
})
export class HomeLink {}
