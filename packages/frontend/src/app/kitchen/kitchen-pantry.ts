import { Component, effect, inject, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { KitchenTabs } from './kitchen-tabs';

/**
 * Kitchen's On hand tab (`/kitchen/pantry`, #220): opens the pantry note
 * (#131), made first if no device has yet, as /kitchen opens the week.
 */
@Component({
  selector: 'app-kitchen-pantry',
  imports: [KitchenTabs, RouterLink],
  template: `
    <main class="page">
      <app-kitchen-tabs active="pantry" heading />
      @if (!modules.kitchen()) {
        <p>
          What is on hand is part of Kitchen, which is switched off.
          <a routerLink="/settings" fragment="modules">Switch it on in Settings</a>.
        </p>
      } @else {
        <p role="status">Opening what is on hand…</p>
      }
    </main>
  `,
})
export class KitchenPantry {
  protected readonly modules = inject(ModulesService);
  private readonly notes = inject(NotesService);
  private readonly router = inject(Router);

  constructor() {
    effect(() => {
      if (!this.modules.kitchen() || !this.notes.loaded()) return;
      untracked(() => {
        const id = this.notes.ensurePantry();
        if (id) void this.router.navigate(['/n', id], { replaceUrl: true });
      });
    });
  }
}
