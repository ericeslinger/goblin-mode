import { Component, booleanAttribute, computed, inject, input } from '@angular/core';
import { checklist } from '@mossgoblin/schema';
import { PageHeader } from '../home/page-header';
import { type ModuleTab, ModuleTabs } from '../home/module-tabs';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import { GroceryService } from './grocery.service';

export type KitchenTab = 'meals' | 'shopping' | 'recipes' | 'pantry';

/**
 * The Kitchen tab a note is the screen of (#220): a week's plan is
 * Meals, the pantry On hand, a grocery list Shopping; none while
 * Kitchen is off. The note page draws the tabs by it, and the rail
 * (#289) marks Kitchen current by it.
 */
export function kitchenTabOf(
  note: NoteRecord | undefined,
  kitchenOn: boolean,
  isList: (note: NoteRecord) => boolean,
): KitchenTab | undefined {
  if (!note || !kitchenOn) return undefined;
  if (note.kind === 'mealplan') return 'meals';
  if (note.kind === 'pantry') return 'pantry';
  return isList(note) ? 'shopping' : undefined;
}

/**
 * Kitchen's tabs (#220): Meals (`/kitchen`, this week's plan, or the
 * week shown), Shopping (`/kitchen/shopping`, with what is left to buy),
 * Recipes (`/kitchen/recipes`) and On hand (`/kitchen/pantry`). With
 * `heading`, the module's header above them: the page header (#286),
 * the leaf and Kitchen, with what is projected as its actions. Since
 * #288 (2026-11-15) the note page draws them so over a week's plan and
 * the pantry too, its View, Back and More as those actions, so the
 * tabs never move from one tab to the next; over the grocery list's
 * text, a screen the Shopping tab leads to, it draws them without,
 * under its own bar.
 */
@Component({
  selector: 'app-kitchen-tabs',
  imports: [ModuleTabs, PageHeader],
  template: `
    @if (heading()) {
      <app-page-header title="Kitchen"><ng-content /></app-page-header>
    }
    <app-module-tabs label="Kitchen screens" [tabs]="tabs()" />
  `,
  styles: `
    :host {
      display: block;
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
