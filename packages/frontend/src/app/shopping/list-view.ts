import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { checklist, doneShopping, merge3, setDone } from '@mossgoblin/schema';

/** How long Done shopping offers Undo. */
export const UNDO_MS = 8_000;

/**
 * A list note to shop from (#39): each section's open items as large
 * checkboxes, and everything ticked sunk to Got it. Ticking changes only
 * that item's mark; Done shopping clears the ticked items and brings
 * starred staples back. The note's text stays the source of truth.
 */
@Component({
  selector: 'app-list-view',
  template: `
    <section class="list" aria-label="List">
      @for (section of open(); track section.heading; let i = $index) {
        @if (section.heading) {
          <h2 [id]="'list-' + i">{{ section.heading }}</h2>
        }
        <ul [attr.aria-labelledby]="section.heading ? 'list-' + i : null">
          @for (item of section.items; track item.line) {
            <li>
              <label>
                <input type="checkbox" (change)="tick(item.line, item.text, true)" />
                {{ item.text }}
              </label>
            </li>
          }
        </ul>
      }
      @if (got().length) {
        <h2 id="got-it">Got it</h2>
        <ul aria-labelledby="got-it" class="got">
          @for (item of got(); track item.line) {
            <li>
              <label>
                <input type="checkbox" checked (change)="tick(item.line, item.text, false)" />
                {{ item.text }}
              </label>
            </li>
          }
        </ul>
        <button type="button" class="done" (click)="done()">Done shopping</button>
      }
      @if (cleared()) {
        <p class="cleared" role="status">
          List cleared.
          <button type="button" (click)="undo()">Undo</button>
        </p>
      }
      @if (!open().length && !got().length) {
        <p class="muted">No items yet. Add lines like "- [ ] apples" to the note.</p>
      }
    </section>
  `,
  styles: `
    .list {
      padding: var(--space-2) var(--space-3);
      overflow: auto;
    }
    h2 {
      font-size: 16px;
      margin: var(--space-3) 0 var(--space-1);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      border-bottom: 1px solid var(--rule);
    }
    label {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 44px;
      cursor: pointer;
    }
    input {
      width: 22px;
      height: 22px;
      accent-color: var(--accent);
    }
    .got label {
      color: var(--quiet);
      text-decoration: line-through;
    }
    .done {
      margin-top: var(--space-3);
      font: inherit;
      padding: 8px 18px;
      border: 0;
      border-radius: var(--radius-pill);
      color: var(--on-accent);
      background: var(--accent);
      cursor: pointer;
    }
    .muted {
      color: var(--quiet);
    }
    .cleared {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .cleared button {
      font: inherit;
      padding: 4px 12px;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-pill);
      color: var(--ink);
      background: var(--surface);
      cursor: pointer;
    }
  `,
})
export class ListView {
  readonly body = input.required<string>();
  /** The note's new text, after a tick or Done shopping (`keep`). */
  readonly edited = output<{ body: string; keep: boolean }>();

  private readonly sections = computed(() => checklist(this.body()));
  protected readonly open = computed(() =>
    this.sections()
      .map((s) => ({ heading: s.heading, items: s.items.filter((i) => !i.done) }))
      .filter((s) => s.items.length),
  );
  protected readonly got = computed(() =>
    this.sections().flatMap((s) => s.items.filter((i) => i.done)),
  );

  /** The list before Done shopping and just after, while Undo is offered. */
  protected readonly cleared = signal<{ before: string; after: string } | undefined>(undefined);
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected tick(line: number, text: string, done: boolean): void {
    this.edited.emit({ body: setDone(this.body(), line, done, text), keep: false });
  }

  protected done(): void {
    const before = this.body();
    const after = doneShopping(before);
    this.edited.emit({ body: after, keep: true });
    this.cleared.set({ before, after });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cleared.set(undefined), UNDO_MS);
  }

  /**
   * Puts back what Done shopping cleared, and only that: anything added
   * since (Claude, another device, typing) stays (#37's merge).
   */
  protected undo(): void {
    const cleared = this.cleared();
    if (!cleared) return;
    this.edited.emit({ body: merge3(cleared.after, this.body(), cleared.before), keep: false });
    this.cleared.set(undefined);
  }
}
