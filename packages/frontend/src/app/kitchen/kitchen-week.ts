import { Component, effect, inject, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { isIsoDate, localDate, periodStartFor } from '@mossgoblin/schema';
import { map } from 'rxjs';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW } from '../platform/platform';

/**
 * /kitchen and /kitchen/<a day> (#129): opens the meal plan for the week
 * holding that day (today by default), making it first if no device has
 * yet. The plan is a note, so it opens on the note page, its week drawn
 * above its text.
 */
@Component({
  selector: 'app-kitchen-week',
  imports: [RouterLink],
  template: `
    <main class="page">
      <a routerLink="/">Back</a>
      <h1>Meal plan</h1>
      @if (!modules.kitchen()) {
        <p>
          The meal plan is part of Kitchen, which is switched off.
          <a routerLink="/settings" fragment="modules">Switch it on in Settings</a>.
        </p>
      } @else {
        <p role="status">Opening the week…</p>
      }
    </main>
  `,
})
export class KitchenWeek {
  protected readonly modules = inject(ModulesService);
  private readonly notes = inject(NotesService);
  private readonly router = inject(Router);
  private readonly now = inject(NOW);
  private readonly day = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('day') ?? '')),
    { initialValue: '' },
  );

  constructor() {
    effect(() => {
      // The plan is made to the stored configuration, once it is read,
      // and once the notes are here, so another device's plan is found.
      if (!this.modules.kitchen() || !this.modules.loaded() || !this.notes.loaded()) return;
      const day = isIsoDate(this.day()) ? this.day() : localDate(this.now());
      const config = this.modules.kitchenConfig();
      untracked(() => {
        const id = this.notes.ensurePlan(periodStartFor(day, config.weekStart), config);
        if (id) void this.router.navigate(['/n', id], { replaceUrl: true });
      });
    });
  }
}
