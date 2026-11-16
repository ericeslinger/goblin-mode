import { Component, computed, input, output, signal } from '@angular/core';
import { plainText } from '@mossgoblin/editor/grammar';
import { editPantry, itemKey, OTHER, pantryItems } from '@mossgoblin/schema';
import { pantryExtras, pantrySections, shownSections } from './kitchen-lines';

/**
 * On hand as a page to read (#288, 2026-11-15): the pantry note's
 * sections with their items, a section with nothing under it left out,
 * and Add to, which offers every section the note has, empty ones too,
 * and Other. Adding is an edit of the text that writes only the item's
 * line (`editPantry`, as Claude's `update_pantry` does), emitted for
 * the editor to show and save, so typing in the text is kept. Lines
 * that are neither items nor headings show as plain words below.
 */
@Component({
  selector: 'app-pantry-view',
  template: `
    <section class="pantry" aria-label="On hand">
      @for (s of shown(); track $index) {
        @if (s.heading) {
          <h2>{{ plain(s.heading) }}</h2>
        }
        <ul [attr.aria-label]="s.heading ? plain(s.heading) : 'Not in a section'">
          @for (p of s.items; track p.line) {
            <li>
              <!-- As the pantry writes it, "salt: always", the colon kept so
                   the words never run together. -->
              <span class="item">{{ plain(p.item) }}</span>
              @if (p.always) {
                <span class="muted">{{ ': always' }}</span>
              } @else if (p.amount) {
                <span class="muted">{{ ': ' + p.amount }}</span>
              }
            </li>
          }
        </ul>
      } @empty {
        <p class="muted">Nothing on hand yet.</p>
      }
      <form class="add" (submit)="$event.preventDefault(); add(item, section)">
        <label>
          New item
          <input #item name="item" autocomplete="off" enterkeyhint="done" placeholder="limes" />
        </label>
        <label>
          Add to
          <select #section name="section">
            @for (name of sections(); track name) {
              <option [value]="name">{{ plain(name) }}</option>
            }
          </select>
        </label>
        <button type="submit">Add</button>
      </form>
      @if (said()) {
        <p class="muted" role="status">{{ said() }}</p>
      }
      @if (extras().length) {
        <section class="extras" aria-labelledby="pantry-extras">
          <h2 id="pantry-extras">Also in this note</h2>
          <ul aria-labelledby="pantry-extras">
            @for (line of extras(); track $index) {
              <li>{{ line }}</li>
            }
          </ul>
          <button type="button" class="link" (click)="editText.emit()">Edit as text</button>
        </section>
      }
    </section>
  `,
  styles: `
    .pantry {
      padding: var(--space-2) var(--space-3) var(--space-3);
    }
    h2 {
      margin: var(--space-3) 0 var(--space-1);
      font-size: 15px;
      color: var(--quiet);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      padding: 6px 0;
      border-bottom: 1px solid var(--rule);
    }
    .item {
      overflow-wrap: anywhere;
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
    .add {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: flex-end;
      margin-top: var(--space-3);
    }
    .add label {
      display: grid;
      gap: 2px;
      font-size: 14px;
      color: var(--quiet);
    }
    .add input,
    .add select {
      font: inherit;
      font-size: 16px;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: var(--space-1) var(--space-2);
      min-height: 36px;
    }
    @media (pointer: coarse) {
      .add input,
      .add select {
        min-height: 44px;
      }
    }
    .extras {
      margin-top: var(--space-4);
    }
    .extras li {
      color: var(--quiet);
    }
    .extras .link {
      margin-top: var(--space-2);
    }
  `,
})
export class PantryView {
  /** The pantry's text as the editor has it, typing included. */
  readonly body = input.required<string>();
  /** The pantry's new text, for the editor to show and save. */
  readonly edited = output<string>();
  /** Edit as text, from the lines shown as plain words. */
  readonly editText = output<void>();

  protected readonly said = signal('');
  private readonly all = computed(() => pantrySections(this.body()));
  protected readonly shown = computed(() => shownSections(this.all()));
  protected readonly extras = computed(() => pantryExtras(this.body()));
  /** Every heading the note has, empty or not, and Other, where an unsorted item goes. */
  protected readonly sections = computed(() => {
    const names = this.all()
      .map((s) => s.heading)
      .filter((h) => h.trim());
    const seen = new Set<string>();
    const out = names.filter((h) => {
      const k = h.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return seen.has(OTHER.toLowerCase()) ? out : [...out, OTHER];
  });

  protected plain(text: string): string {
    return plainText(text) || text;
  }

  /** "limes", or "rice: half a bag", or "salt: always", under the section chosen. */
  protected add(input: HTMLInputElement, select: HTMLSelectElement): void {
    const typed = input.value.trim();
    if (!typed) return;
    const colon = typed.indexOf(':');
    const item = (colon > 0 ? typed.slice(0, colon) : typed).trim();
    const amount = colon > 0 ? typed.slice(colon + 1).trim() : '';
    if (!item) return;
    const body = this.body();
    if (pantryItems(body).some((p) => p.key === itemKey(item))) {
      this.said.set(`${item} is on hand already.`);
      return;
    }
    const section = select.value || OTHER;
    const always = /^always$/i.test(amount);
    this.edited.emit(
      editPantry(body, {
        add: [{ item, section, ...(always ? { always } : amount ? { amount } : {}) }],
      }),
    );
    input.value = '';
    this.said.set(`Added ${item} to ${section}.`);
  }
}
