import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { listSections } from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { ListView } from '../shopping/list-view';
import { GroceryService } from './grocery.service';
import { KitchenTabs } from './kitchen-tabs';

/**
 * Kitchen's Shopping tab (`/kitchen/shopping`, #220): the grocery list,
 * found as GroceryService finds it, to shop from in List view, as its
 * note shows it; Make the grocery list while there is none. Ticks and
 * Done shopping are written through the persistent cache like any
 * note, and Done shopping keeps the list's sections and puts what was
 * bought on hand, as on the note page (#130, #131).
 */
@Component({
  selector: 'app-kitchen-shopping',
  imports: [KitchenTabs, ListView, RouterLink],
  template: `
    <main class="page">
      <app-kitchen-tabs active="shopping" heading />
      @if (!modules.kitchen()) {
        <p>
          The grocery list is part of Kitchen, which is switched off.
          <a routerLink="/settings" fragment="modules">Switch it on in Settings</a>.
        </p>
      } @else if (list(); as note) {
        <div class="head">
          <h2>{{ note.title }}</h2>
          <a [routerLink]="['/n', note.id]">Edit the list</a>
        </div>
        <app-list-view [body]="body()" (edited)="change(note, $event)" />
      } @else if (notes.loaded()) {
        <p class="none">
          No grocery list yet.
          <button type="button" (click)="grocery.makeList()">Make the grocery list</button>
        </p>
      }
    </main>
  `,
  styles: `
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    h2 {
      flex: 1;
      margin: 0;
      font-size: 17px;
    }
    .head a {
      font-size: 14px;
    }
    .none {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
  `,
})
export class KitchenShopping {
  protected readonly modules = inject(ModulesService);
  protected readonly notes = inject(NotesService);
  protected readonly grocery = inject(GroceryService);

  protected readonly list = computed(() => {
    const id = this.grocery.listId();
    return id ? this.notes.find(id) : undefined;
  });
  /** The text last written here, until the list's next snapshot, so quick ticks build on each other. */
  private readonly written = signal<string | undefined>(undefined);
  protected readonly body = computed(() => this.written() ?? this.list()?.body ?? '');

  constructor() {
    effect(() => {
      this.list()?.body;
      untracked(() => this.written.set(undefined));
    });
  }

  protected change(note: NoteRecord, change: { body: string; keep: boolean }): void {
    const before = this.body();
    // Done shopping: where items were filed is kept, and what was bought is on hand.
    if (change.keep) {
      this.grocery.remember(listSections(before));
      this.grocery.bought(before);
    }
    this.written.set(change.body);
    this.notes.save(note.id, change.body, { base: before, keep: change.keep });
  }
}
