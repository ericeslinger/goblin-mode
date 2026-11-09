import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from './icon';

/**
 * The leaf (#219): Home, from the top left of every screen, where Back
 * to the start screen used to be. A 44 px target.
 */
@Component({
  selector: 'app-home-link',
  imports: [RouterLink, Icon],
  template: `<a routerLink="/home" aria-label="Home"><app-icon name="leaf" /></a>`,
  styles: `
    :host {
      display: inline-flex;
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
  `,
})
export class HomeLink {}
