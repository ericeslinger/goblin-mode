import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  type ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { PLACES } from '../home/places';
import { type Command, GO_KEYS, PLACE_ORDER, filterCommands } from './shortcuts';
import { ShortcutsService } from './shortcuts.service';

/** Cmd on a Mac, Ctrl elsewhere, as the hints name the chord. */
function chordName(doc: Document): string {
  const platform = doc.defaultView?.navigator.platform ?? '';
  return /Mac|iPhone|iPad/.test(platform) ? '⌘ K' : 'Ctrl K';
}

/**
 * The command box (#289, Eric 2026-11-15): Ctrl K or Cmd K, from any
 * screen. A modal dialog, as the app's sheets are, with one field, "Go
 * to or do", a combobox over the list of what matches: the places, New
 * note, Search notes and each page of Settings. Up and Down move, Enter
 * runs, Escape closes, and the focus goes back where it was. With
 * nothing typed it also says the keys.
 */
@Component({
  selector: 'app-command-box',
  template: `
    <dialog
      #dialog
      class="box"
      aria-labelledby="command-box-label"
      (keydown)="key($event)"
      (close)="restore()"
      (click)="backdrop($event)"
    >
      <label id="command-box-label" for="command-box-input">Go to or do</label>
      <input
        #input
        id="command-box-input"
        type="text"
        role="combobox"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        enterkeyhint="go"
        aria-autocomplete="list"
        [attr.aria-keyshortcuts]="chord === '⌘ K' ? 'Meta+K' : 'Control+K'"
        [attr.aria-expanded]="shown().length > 0"
        [attr.aria-controls]="shown().length ? 'command-box-list' : null"
        [attr.aria-activedescendant]="activeId()"
        (input)="type($event)"
      />
      @if (shown().length) {
        <ul #list id="command-box-list" role="listbox" aria-label="Commands">
          @for (c of shown(); track c.id; let i = $index) {
            <li
              role="option"
              [id]="'command-' + c.id"
              [attr.aria-selected]="i === active()"
              (pointermove)="active.set(i)"
              (click)="run(c)"
            >
              <span class="label">{{ c.label }}</span>
              @if (c.keys) {
                <kbd aria-hidden="true">{{ c.keys }}</kbd>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="none" role="status">Nothing matches.</p>
      }
      @if (!query()) {
        <ul class="hints" aria-label="Keys">
          <li><kbd>/</kbd> search</li>
          <li><kbd>g</kbd> then a letter: {{ letters() }}</li>
          <li>
            <kbd>{{ chord }}</kbd> this box (in a note's text, a link)
          </li>
        </ul>
      }
    </dialog>
  `,
  styles: `
    .box {
      box-sizing: border-box;
      width: min(100% - 32px, 480px);
      max-height: calc(100% - 12vh - 16px);
      margin: 12vh auto auto;
      padding: var(--space-3);
      color: var(--ink);
      background: var(--surface);
      border: var(--border, 1px) solid var(--rule);
      border-radius: var(--radius-card);
      overflow: hidden;
    }
    .box[open] {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .box::backdrop {
      background: color-mix(in srgb, var(--ink) 35%, transparent);
    }
    label {
      font-weight: 600;
    }
    input {
      box-sizing: border-box;
      width: 100%;
      min-height: 44px;
      font: inherit;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    [role='listbox'] {
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    [role='option'] {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 40px;
      padding: 0 var(--space-2);
      border-radius: var(--radius-control);
      cursor: pointer;
    }
    [role='option'][aria-selected='true'] {
      background: var(--chip-bg);
      font-weight: 600;
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .label {
      flex: 1 1 auto;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    kbd {
      flex: none;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--quiet);
    }
    .none,
    .hints {
      margin: 0;
      color: var(--quiet);
      font-size: 14px;
    }
    .hints {
      display: grid;
      gap: 2px;
      padding-top: var(--space-2);
      border-top: var(--border, 1px) solid var(--rule);
    }
    .hints kbd {
      color: var(--ink);
    }
  `,
})
export class CommandBox {
  private readonly shortcuts = inject(ShortcutsService);
  private readonly doc = inject(DOCUMENT);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');
  private readonly list = viewChild<ElementRef<HTMLUListElement>>('list');
  /** What had the focus when the box opened, given it back on close. */
  private returnTo?: HTMLElement;

  protected readonly chord = chordName(this.doc);
  private readonly commands = signal<Command[]>([]);
  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly shown = computed(() => filterCommands(this.commands(), this.query()));
  protected readonly activeId = computed(() => {
    const c = this.shown()[this.active()];
    return c ? `command-${c.id}` : null;
  });
  /** "h Home, n Notes, ...": the places offered now, by their letters. */
  protected readonly letters = computed(() =>
    PLACE_ORDER.filter((id) => this.commands().some((c) => c.id === `go-${id}`))
      .map((id) => `${GO_KEYS[id]} ${PLACES[id].name}`)
      .join(', '),
  );

  constructor() {
    inject(DestroyRef).onDestroy(this.shortcuts.attachBox(() => this.open()));
  }

  /** Opens the box, empty, its field focused; the commands as they are now. */
  open(): void {
    const dialog = this.dialog().nativeElement;
    if (dialog.open) return;
    const focused = this.doc.activeElement;
    this.returnTo =
      focused instanceof HTMLElement && focused !== this.doc.body ? focused : undefined;
    this.commands.set(this.shortcuts.commands());
    this.query.set('');
    this.active.set(0);
    this.input().nativeElement.value = '';
    dialog.showModal();
    this.input().nativeElement.focus();
  }

  /** Closes it, the focus back where it was, at once (the close event comes later). */
  close(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) return;
    dialog.close();
    this.restore();
  }

  /** The focus back on what had it, the editor's caret and all; once. */
  protected restore(): void {
    const to = this.returnTo;
    this.returnTo = undefined;
    if (to?.isConnected) to.focus({ preventScroll: true });
  }

  protected type(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.active.set(0);
  }

  protected run(command: Command): void {
    this.close();
    command.run();
  }

  /**
   * The box's keys. None goes further: the screen under it (the
   * Reader's j, k, Escape) must not hear what is typed here.
   */
  protected key(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    const n = this.shown().length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (!n) return;
        event.preventDefault();
        this.active.update((i) => (i + (event.key === 'ArrowDown' ? 1 : n - 1)) % n);
        this.list()
          ?.nativeElement.querySelector(`#${CSS.escape(this.activeId() ?? '')}`)
          ?.scrollIntoView?.({ block: 'nearest' });
        return;
      case 'Enter': {
        event.preventDefault();
        const command = this.shown()[this.active()];
        if (command) this.run(command);
        return;
      }
      case 'Escape':
        event.preventDefault();
        this.close();
        return;
      default:
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          this.close();
        }
    }
  }

  /**
   * A click on the backdrop closes it, as the sheets do: one on the
   * dialog itself outside its box (its own padding is inside).
   */
  protected backdrop(event: MouseEvent): void {
    const dialog = this.dialog().nativeElement;
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= r.left &&
      event.clientX <= r.right &&
      event.clientY >= r.top &&
      event.clientY <= r.bottom;
    if (!inside) this.close();
  }
}
