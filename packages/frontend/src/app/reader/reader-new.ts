import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { ItemsService } from './items.service';

/** Right Now names at most this many folders with new articles (#173). */
export const NEW_FOLDERS = 3;

/**
 * What is new in the Reader, for Right Now (#173): a line per folder
 * with unread articles newer than its list was last opened, at most
 * three, then how many more folders. Counted on the device from the
 * articles at hand; nothing when the module is off or nothing is new.
 */
@Component({
  selector: 'app-reader-new',
  imports: [RouterLink],
  template: `
    @if (modules.reader() && lines().length) {
      <ul class="reader-new" aria-label="New in the Reader">
        @for (l of lines(); track l.folder) {
          <li>
            <a [routerLink]="['/reader/f', l.folder]">{{ l.count }} new in {{ l.folder }}</a>
          </li>
        }
        @if (more(); as n) {
          <li>
            <a routerLink="/reader/folders"
              >and {{ n }} more {{ n === 1 ? 'folder' : 'folders' }}</a
            >
          </li>
        }
      </ul>
    }
  `,
  styles: `
    ul {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
    }
    a {
      color: var(--accent);
    }
  `,
})
export class ReaderNew {
  protected readonly modules = inject(ModulesService);
  private readonly items = inject(ItemsService);
  protected readonly lines = computed(() => this.items.newSince().slice(0, NEW_FOLDERS));
  protected readonly more = computed(() => this.items.newSince().length - this.lines().length);
}
