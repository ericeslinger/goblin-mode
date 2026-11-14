import {
  Component,
  type ElementRef,
  InjectionToken,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { hostOf } from '@mossgoblin/schema';
import { httpsCallable } from 'firebase/functions';
import { FIREBASE } from '../firebase';
import type { NoteRecord } from '../notes/notes.service';
import { ONLINE } from '../platform/platform';

/** What the server made of a pasted page. */
export type PastedImport = { state: 'done' } | { state: 'failed'; error: string };

/** The call that imports a pasted page (onCall), as a seam for unit specs. */
export interface RecipeImportApi {
  importPasted(noteId: string, text: string): Promise<PastedImport>;
}

/** The server's most, here too, so a paste too big is refused at once. */
export const MAX_PASTED_CHARS = 1_000_000;

export const RECIPE_IMPORT_API = new InjectionToken<RecipeImportApi>('recipe-import-api', {
  providedIn: 'root',
  factory: () => {
    const { functions } = inject(FIREBASE);
    // A model's read of a page can take minutes; the function allows five.
    const call = httpsCallable<unknown, PastedImport>(functions, 'importPastedRecipe', {
      timeout: 310_000,
    });
    return { importPasted: async (noteId, text) => (await call({ noteId, text })).data };
  },
});

/**
 * Paste the page instead (2026-11-14): under a recipe whose import
 * failed, most often a site that will not let Mossgoblin read it. A
 * browser cannot fetch another site's page (CORS), so Eric opens it
 * himself, selects all, copies and pastes it here, and the server reads
 * the paste as it reads a fetched page. What he pasted stays in the box
 * until the import succeeds: offline, or if the call fails, it waits
 * here and says why.
 */
@Component({
  selector: 'app-recipe-paste',
  template: `
    @if (shown()) {
      @if (!open()) {
        <button #toggle type="button" class="toggle" (click)="show()">
          Paste the page instead
        </button>
      } @else {
        <form class="paste" (submit)="$event.preventDefault(); submit()">
          <p class="help" id="paste-help-{{ note().id }}">
            Open the recipe on {{ site() }} in your browser, select all, copy, and paste it here.
            Mossgoblin reads the recipe out of it; the link stays as its source.
          </p>
          <label class="visually-hidden" for="paste-{{ note().id }}">Pasted page</label>
          <textarea
            #box
            id="paste-{{ note().id }}"
            rows="6"
            [attr.aria-describedby]="'paste-help-' + note().id"
            [value]="text()"
            (input)="typed($any($event.target).value)"
          ></textarea>
          <div class="actions">
            <button type="submit" [disabled]="busy() || !text().trim()">Import</button>
            @if (!busy()) {
              <button type="button" class="quiet" (click)="close()">Cancel</button>
            }
          </div>
          <p class="said" aria-live="polite">{{ said() }}</p>
        </form>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .toggle,
    .quiet {
      font: inherit;
      font-size: 14px;
      color: var(--accent);
      background: none;
      border: 0;
      padding: 0;
      text-decoration: underline;
      cursor: pointer;
    }
    .toggle {
      margin: 0 0 var(--space-2);
    }
    .paste {
      margin: 0 0 var(--space-2);
      font-size: 14px;
    }
    .help {
      margin: 0 0 var(--space-1);
      color: var(--quiet);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font: inherit;
      color: var(--ink);
      background: transparent;
      border: 1px solid var(--rule);
      border-radius: 4px;
      padding: var(--space-1);
      resize: vertical;
    }
    .actions {
      display: flex;
      gap: var(--space-3);
      align-items: center;
      margin-top: var(--space-1);
    }
    .said {
      margin: var(--space-1) 0 0;
      color: var(--quiet);
    }
    .said:empty {
      display: none;
    }
  `,
})
export class RecipePaste {
  readonly note = input.required<NoteRecord>();
  private readonly injector = inject(Injector);
  private readonly online = inject(ONLINE);

  /** What Eric pasted, kept here until an import of it succeeds. */
  protected readonly text = signal('');
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly said = signal('');

  protected readonly site = computed(() => hostOf(this.note().source?.url ?? '') || 'its site');

  /**
   * On a recipe with a link whose import failed; and still while a
   * paste is read or waits here, whatever the recipe's state says.
   */
  protected readonly shown = computed(
    () =>
      !!this.note().source?.url &&
      (this.note().importState === 'failed' || this.busy() || !!this.text()),
  );

  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  private readonly toggle = viewChild<ElementRef<HTMLButtonElement>>('toggle');

  /** Opens the box with the keyboard's focus in it. */
  protected show(): void {
    this.open.set(true);
    afterNextRender(() => this.box()?.nativeElement.focus(), { injector: this.injector });
  }

  protected typed(value: string): void {
    this.text.set(value);
    if (!this.busy()) this.said.set('');
  }

  protected close(): void {
    this.text.set('');
    this.said.set('');
    this.open.set(false);
    afterNextRender(() => this.toggle()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async submit(): Promise<void> {
    const text = this.text();
    if (this.busy() || !text.trim()) return;
    if (text.length > MAX_PASTED_CHARS) {
      this.said.set(
        'That is over a million characters. Copy the page itself (select all, copy), not its source.',
      );
      return;
    }
    if (!this.online()) {
      this.said.set('Importing needs a connection. What you pasted stays here until then.');
      return;
    }
    const id = this.note().id;
    this.busy.set(true);
    this.said.set('Reading the recipe from what you pasted…');
    try {
      const result = await this.injector.get(RECIPE_IMPORT_API).importPasted(id, text);
      if (result.state === 'done') {
        this.said.set('');
        // The box takes typing while the paste is read (review on
        // #268); what was typed since stays in it.
        if (this.text() === text) {
          this.text.set('');
          this.open.set(false);
        }
      } else {
        this.said.set(`Could not import it: ${result.error}.`);
      }
    } catch (err) {
      this.said.set(failure(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Why the call failed, kept short; what was pasted stays either way. */
function failure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') {
    return `Could not import it: ${message}.`;
  }
  return 'Could not reach Mossgoblin to import it; this needs a connection. What you pasted stays here.';
}
