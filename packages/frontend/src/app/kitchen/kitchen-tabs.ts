import { Component, booleanAttribute, computed, inject, input } from '@angular/core';
import { checklist } from '@mossgoblin/schema';
import { HomeLink } from '../home/home-link';
import { type ModuleTab, ModuleTabs } from '../home/module-tabs';
import { NotesService } from '../notes/notes.service';
import { GroceryService } from './grocery.service';

export type KitchenTab = 'meals' | 'shopping' | 'recipes' | 'pantry';

/**
 * Kitchen's tabs (#220): Meals (`/kitchen`, this week's plan, or the
 * week shown), Shopping (`/kitchen/shopping`, with what is left to buy),
 * Recipes (`/kitchen/recipes`) and On hand (`/kitchen/pantry`). With
 * `heading`, the module's header above them: the leaf and Kitchen. The
 * note page draws them without, under its own bar, on a week's plan,
 * the pantry and the grocery list.
 */
@Component({
  selector: 'app-kitchen-tabs',
  imports: [HomeLink, ModuleTabs],
  template: `
    @if (heading()) {
      <header>
        <app-home-link />
        <h1>Kitchen</h1>
      </header>
    }
    <app-module-tabs label="Kitchen screens" [tabs]="tabs()" />
  `,
  styles: `
    :host {
      display: block;
    }
    header {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin-bottom: var(--space-2);
    }
    h1 {
      margin: 0;
      font-size: 20px;
    }
  `,
})
export class KitchenTabs {
  readonly active = input.required<KitchenTab>();
  /** `page` on the tab's own screen; `true` on a screen it leads to (the list's text). */
  readonly current = input<'page' | 'true'>('page');
  readonly heading = input(false, { transform: booleanAttribute });

  private readonly grocery = inject(GroceryService);
  private readonly notes = inject(NotesService);

  /** What the grocery list has open, or nothing while there is no list. */
  private readonly toBuy = computed(() => {
    const id = this.grocery.listId();
    const list = id ? this.notes.find(id) : undefined;
    if (!list) return undefined;
    return checklist(list.body).reduce((n, s) => n + s.items.filter((i) => !i.done).length, 0);
  });

  protected readonly tabs = computed<ModuleTab[]>(() => {
    const at = (tab: KitchenTab) => (this.active() === tab ? this.current() : undefined);
    return [
      { name: 'Meals', link: '/kitchen', current: at('meals') },
      {
        name: 'Shopping',
        link: '/kitchen/shopping',
        count: this.toBuy(),
        counts: 'to buy',
        current: at('shopping'),
      },
      { name: 'Recipes', link: '/kitchen/recipes', current: at('recipes') },
      { name: 'On hand', link: '/kitchen/pantry', current: at('pantry') },
    ];
  });
}
