import { Component, computed, input, output, signal } from '@angular/core';
import { plainText } from '@mossgoblin/editor/grammar';
import { editPantry, itemKey, itemText, OTHER, pantryItems } from '@mossgoblin/schema';
import { pantrySections, shownSections, wordlessLine } from './kitchen-lines';

/**
 * On hand as a page to read (#288, 2026-11-15): the pantry note's
 * sections with their items, a section with nothing under it left out,
 * and Add to, which offers every section the note has, empty ones too,
 * and Other. Adding is an edit of the text that writes only the item's
 * line (`editPantry`, as Claude's `update_pantry` does), emitted for
 * the editor to show and save, so typing in the text is kept. Every
 * line that is not blank shows (2026-11-16): one that is neither an
 * item nor a heading as plain words under its section, so a heading
 * holding only such lines shows too; a line with no words to show is
 * counted, "N more lines without words", with Edit as text beside it.
 */
@Component({
  selector: 'app-pantry-view',
  template: `
    <section class="pantry" aria-label="On hand">
      @for (s of shown(); track $index) {
        @if (s.heading) {
          <h2>{{ plain(s.heading) }}</h2>
        }
        @if (s.items.length || s.extras.length) {
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
            @for (x of s.extras; track x.line) {
              <li class="extra">{{ x.words }}</li>
            }
          </ul>
        }
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
      @if (wordless()) {
        <p class="wordless muted">
          {{ wordless() }}
          <span aria-hidden="true">{{ ' · ' }}</span>
          <button type="button" class="link" (click)="editText.emit()">Edit as text</button>
        </p>
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
    .extra {
      color: var(--quiet);
    }
    .wordless {
      margin-top: var(--space-3);
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
  /** "2 more lines without words", over every section, or ''. */
  protected readonly wordless = computed(() =>
    wordlessLine(this.all().reduce((n, s) => n + s.wordless.length, 0)),
  );
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
    // Split as the pantry reads a line, at the last colon (`itemText`);
    // a colon left in the name is a space, as `editPantry` writes it.
    const parts = itemText(typed);
    const item = parts.item.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
    const amount = parts.amount;
    if (!item) return;
    const body = this.body();
    if (pantryItems(body).some((p) => p.key === itemKey(item))) {
      this.said.set(`${item} is on hand already.`);
      return;
    }
    const section = select.value || OTHER;
    const always = parts.always;
    this.edited.emit(
      editPantry(body, {
        add: [{ item, section, ...(always ? { always } : amount ? { amount } : {}) }],
      }),
    );
    input.value = '';
    this.said.set(`Added ${item} to ${section}.`);
  }
}
