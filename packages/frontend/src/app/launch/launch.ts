import {
  Component,
  DestroyRef,
  type ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { ActivatedRoute, NavigationStart, Router, RouterLink } from '@angular/router';
import {
  CONCEPT_PREFIX,
  CONTEXT_ID,
  CONTEXT_MAX,
  templateParts,
  checklist,
  normalizeName,
  suggestLinks,
  suggestMoods,
  listSections,
  withProjectSections,
} from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { projectTree } from '../browse/lenses';
import { NoteList } from '../browse/note-list';
import { ConceptHeader } from '../links/concept-header';
import { NoteBack } from '../back/note-back';
import { GroceryService } from '../kitchen/grocery.service';
import { type KitchenTab, KitchenTabs, kitchenTabOf } from '../kitchen/kitchen-tabs';
import { HomeLink } from '../home/home-link';
import { Icon } from '../home/icon';
import { NewNoteService } from '../home/new-note';
import { LastPlaceService } from './last-place.service';
import { type Spot } from './place';
import { MealPlanHeader } from '../kitchen/meal-plan-header';
import { PantryView } from '../kitchen/pantry-view';
import { RecipeHeader } from '../kitchen/recipe-header';
import { ClippingHeader } from '../reader/clipping-header';
import { FreshCounts } from '../reminders/fresh-line';
import { rightNowLine } from './right-now-line';
import { CaptureService } from '../capture/capture.service';
import { KEY_SERVICE_MISSING } from '../notes/key-wait-notice';
import { NotesService } from '../notes/notes.service';
import { SignIn } from '../sign-in/sign-in';
import { EditorModeService } from '../note-editor/editor-mode.service';
import { NoteEditorComponent } from '../note-editor/note-editor';
import { ModulesService } from '../modules/modules.service';
import { RemindersService } from '../reminders/reminders.service';
import { RightNowPanel } from '../reminders/right-now-panel';
import { ListView } from '../shopping/list-view';
import { MAX_SHARE, MIN_SHARE, SplitService } from '../split/split.service';
import { TemplateHeader } from '../templates/template-header';
import { SHARE_INBOX } from '../share/share-inbox';
import { ShareWaiting } from '../share/share-waiting';
import { TemplatesService } from '../templates/templates.service';

/**
 * What a share brings, one line each: the title, unless the text has it,
 * then the text, then the link, unless the text has it.
 */
export function sharedText(title: string | null, text: string | null, url: string | null): string {
  const body = text?.trim() ?? '';
  const lines = [
    ...(title?.trim() && !body.includes(title.trim()) ? [title.trim()] : []),
    ...(body ? [body] : []),
    ...(url?.trim() && !body.includes(url.trim()) ? [url.trim()] : []),
  ];
  return lines.join('\n');
}

/**
 * The launch screen: a cursor in a note on top, Right Now below, and
 * on wide screens the notes list beside it, Right Now being the rail's
 * entry there (#289, 2026-11-16). Signed out, only sign-in.
 */
@Component({
  selector: 'app-launch',
  imports: [
    RouterLink,
    HomeLink,
    Icon,
    ConceptHeader,
    NoteEditorComponent,
    NoteBack,
    RecipeHeader,
    ClippingHeader,
    MealPlanHeader,
    PantryView,
    KitchenTabs,
    NgTemplateOutlet,
    NoteList,
    RightNowPanel,
    ListView,
    ShareWaiting,
    SignIn,
    TemplateHeader,
  ],
  templateUrl: './launch.html',
  styleUrl: './launch.css',
})
export class Launch {
  protected readonly auth = inject(AuthService);
  protected readonly capture = inject(CaptureService);
  protected readonly notes = inject(NotesService);
  private readonly router = inject(Router);
  private readonly grocery = inject(GroceryService);
  private readonly route = inject(ActivatedRoute);
  protected readonly modes = inject(EditorModeService);
  protected readonly online = signal(navigator.onLine);
  protected readonly split = inject(SplitService);
  protected readonly minShare = MIN_SHARE;
  protected readonly maxShare = MAX_SHARE;
  protected readonly keyServiceMissing = KEY_SERVICE_MISSING;
  /** Pointer distance below the panel's top edge at grab; null when idle. */
  private grabOffset: number | null = null;

  /**
   * Signed out: sign-in only. While the session is still restoring, a
   * device that has been signed in before gets the editor at once.
   */
  protected readonly showSignIn = computed(() => {
    const user = this.auth.user();
    return user === null || (user === undefined && !this.auth.signedInBefore());
  });

  /** History is for notes that exist; a fresh one has none yet. */
  protected readonly hasHistory = computed(() => {
    this.notes.notes();
    return this.notes.exists(this.capture.open().id);
  });

  /** The note the URL names (`/n/<id>`); undefined on `/`. */
  protected readonly routeId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? undefined)),
  );

  /**
   * A linked note this device does not have yet (not synced, or opened
   * before the notes load): shown read-only until it arrives, so typing
   * can never land on top of it.
   */
  protected readonly waiting = computed(() => {
    this.notes.notes();
    const id = this.routeId();
    return !!id && !this.notes.exists(id);
  });

  protected readonly linkStatus = signal('');
  /** The open note as stored, once it exists (a concept shows its header). */
  protected readonly record = computed(() => this.notes.find(this.capture.open().id));
  /**
   * The open note is sealed and this device cannot open it yet (note
   * encryption step 3a): one calm line instead of its text, and no editor
   * to type over it in. It opens when the key arrives.
   */
  protected readonly locked = computed(() => this.record()?.locked === true);
  /** A list made from a template (#39): it can be shopped from in the list view. */
  protected readonly listable = computed(
    () => !!this.record()?.fromTemplate && checklist(this.capture.current()).length > 0,
  );
  protected readonly listMode = signal(false);
  /** The URL names the context note (#113), made on first open. */
  protected readonly routeIsContext = computed(() => this.routeId() === CONTEXT_ID);
  /** The URL names a concept (its id is derived from its name). */
  protected readonly routeIsConcept = computed(() => !!this.routeId()?.startsWith(CONCEPT_PREFIX));
  /** The URL names a note in Trash (#217): it stays read-only until restored. */
  protected readonly routeInTrash = computed(() => {
    const id = this.routeId();
    return !!id && this.notes.trashed(id) !== undefined;
  });

  /** Names a `[[` can complete to: concepts, synonyms, note titles. */
  protected readonly suggest = (query: string) =>
    suggestLinks(
      query,
      this.notes.notes().filter((n) => !n.locked),
    );
  /** Moods for a Moods line (#40): those starting with what is typed first. */
  protected readonly suggestMood = (query: string) => suggestMoods(query, this.notes.notes());
  private readonly editor = viewChild(NoteEditorComponent);

  /** A template a reminder opened, waiting for the notes to load. */
  private readonly entryFrom = signal<string | undefined>(undefined);
  private readonly shareInbox = inject(SHARE_INBOX);
  private readonly injector = inject(Injector);
  private readonly doc = inject(DOCUMENT);
  /** The note the latest share went into. */
  private shareNote?: string;
  protected readonly previousOpen = signal(false);
  private readonly reminders = inject(RemindersService);
  /**
   * Projects, one tap from any note (2026-10-17): each live project not
   * done, as a tree, with what is open on it: its tasks (reminders
   * linked to it) and the unticked boxes on its page.
   */
  protected readonly modules = inject(ModulesService);
  /** Kitchen's tabs (#220) over a week's plan, the pantry and the grocery list. */
  protected readonly kitchenTab = computed<KitchenTab | undefined>(() =>
    kitchenTabOf(this.record(), this.modules.kitchen(), (note) => this.grocery.isList(note)),
  );
  /**
   * Meals or On hand (#288, 2026-11-15): Kitchen's header and tabs in
   * place of the note bar, with its View, Back and More as the header's
   * actions, and the week or the list as the screen.
   */
  protected readonly kitchenScreen = computed(() => {
    const tab = this.kitchenTab();
    return tab === 'meals' || tab === 'pantry';
  });
  /** Edit as text, from More: the plan's or the pantry's own editor. */
  protected readonly asText = signal(false);
  /** The week or the list shows, and the editor waits behind it. */
  protected readonly kitchenView = computed(() => this.kitchenScreen() && !this.asText());
  /** The way back from the text, named for what it shows. */
  protected readonly kitchenBack = computed(() =>
    this.kitchenTab() === 'meals' ? 'Show the week' : 'Show the list',
  );
  private readonly moreButton = viewChild<ElementRef<HTMLButtonElement>>('moreButton');

  /** To the text, the cursor in it; back to the week or the list. */
  protected setAsText(on: boolean): void {
    this.asText.set(on);
    this.moreOpen.set(false);
    if (on) afterNextRender(() => this.editor()?.focus(), { injector: this.injector });
  }

  /** Back to More's button, wherever the bar or the header has put it. */
  protected focusMore(): void {
    this.moreButton()?.nativeElement.focus();
  }
  protected readonly projects = computed(() => {
    // Off, Projects shows nowhere (#126).
    if (!this.modules.projects()) return [];
    const tasks = new Map<string, number>();
    for (const r of this.reminders.reminders()) {
      if (r.noteId && r.status !== 'done') tasks.set(r.noteId, (tasks.get(r.noteId) ?? 0) + 1);
    }
    const unticked = (body: string) =>
      checklist(body).reduce((sum, s) => sum + s.items.filter((i) => !i.done).length, 0);
    return projectTree(
      this.notes
        .notes()
        .filter(
          (n) =>
            n.kind === 'concept' &&
            n.conceptType === 'project' &&
            n.projectStatus !== 'done' &&
            !n.archived,
        ),
    ).map(({ note, depth }) => ({
      note,
      depth,
      open: (tasks.get(note.id) ?? 0) + unticked(note.body),
    }));
  });
  protected readonly projectsOpen = signal(false);
  /** The back of the open note is showing (#112); each note opens on its front. */
  protected readonly back = signal(false);
  protected readonly contextMax = CONTEXT_MAX;
  /** The open note is being viewed, not edited (2026-10-17). */
  protected readonly viewing = computed(() => this.modes.viewing(this.capture.open().id));
  protected readonly templatesOpen = signal(false);
  /** The More menu (#78): everything but writing, one tap away. */
  protected readonly moreOpen = signal(false);
  protected readonly templates = inject(TemplatesService);
  /** While New rewrites the old note's history entry, its URL does not reopen it. */
  private holdRoute: string | undefined;
  /** The few most recent other notes, for "Previous note". */
  protected readonly previous = computed(() =>
    this.notes
      .notes()
      .filter(
        (n) =>
          !n.archived &&
          n.kind !== 'template' &&
          n.kind !== 'context' &&
          (n.body.trim() || n.locked) &&
          n.id !== this.capture.open().id,
      )
      .slice(0, 5),
  );

  constructor() {
    // The URL says which note is open: /n/<id> that note, / the capture
    // note. Back and forward move between them.
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      if (this.holdRoute && params.get('id') === this.holdRoute) return;
      this.linkStatus.set('');
      const id = params.get('id');
      // Not New's passing rewrite of the old entry (returned above).
      this.noteRoute.set(id ?? undefined);
      if (id) this.capture.openNote(id);
      else this.capture.openHome();
      // From one reminder's link to another, the query does not change.
      if (id && this.route.snapshot.queryParamMap.get('from') === 'reminder') {
        this.entryFrom.set(id);
      }
    });
    // The context note is made the first time it is opened, once online.
    effect(() => {
      if (!this.routeIsContext() || !this.waiting() || !this.notes.loaded() || !this.online()) {
        return;
      }
      untracked(() => void this.notes.makeContext().catch((err) => console.warn(err)));
    });
    // Each note opens on its front. Only another note does: the open note
    // changing (a sync, a merge) leaves the side as it is.
    const openId = computed(() => this.capture.open().id);
    effect(() => {
      openId();
      untracked(() => {
        this.back.set(false);
        // A plan or the pantry opens on its week or list (#288).
        this.asText.set(false);
        // Right Now's sheet closes on going to another note (#287).
        this.rightNowOpen.set(false);
      });
    });
    // Any navigation, back and forward too, closes Right Now's sheet,
    // the Previous note and Projects lists, and More (#287).
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationStart),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.rightNowOpen.set(false);
        this.closeLists();
        this.moreOpen.set(false);
      });
    // Leaving line mode (across 900 px, or to `/`) closes the sheet.
    effect(() => {
      if (!this.lineMode()) untracked(() => this.rightNowOpen.set(false));
    });
    // The sheet keeps the focus it was given: when Done takes the row
    // that had it, the next row's Done has it, else the heading's link.
    effect(() => {
      this.reminders.due();
      if (!untracked(this.rightNowOpen)) return;
      afterNextRender(() => this.keepSheetFocus(), { injector: this.injector });
    });
    // A template from before #111 holds its Instructions for Claude in its
    // text: the first time it is open here, they move to their own field,
    // word for word, and the text keeps the rest. The field is written
    // first; the section leaves the text only once the field reads back
    // holding the same words, so they are never in neither (review on #123).
    effect(() => {
      const note = this.record();
      if (note?.kind !== 'template' || this.waiting()) return;
      if (note.id !== this.capture.open().id) return;
      untracked(() => {
        const { skeleton, instructions } = templateParts(this.capture.current());
        if (!instructions) return;
        if (note.instructions === undefined) this.notes.setInstructions(note.id, instructions);
        else if (note.instructions.trim() === instructions) this.capture.replace(`${skeleton}\n`);
      });
    });
    // New note in the top bar (#272) is this screen's New while it shows.
    const unhandle = inject(NewNoteService).handle(() => this.newNote());
    // The note's scroll and caret are this screen's place (#272): kept
    // as it rests and when the app is hidden, put back on a launch once
    // the note's text is in the editor.
    const unregister = inject(LastPlaceService).register({
      read: () => {
        const id = this.capture.open().id;
        const at = this.editor()?.place() ?? {};
        // On `/`, which capture note, for CaptureService to resume.
        return this.routeId() ? at : { ...at, note: id, saved: this.notes.exists(id) };
      },
      apply: (spot) => this.restorePlace(spot),
    });
    inject(DestroyRef).onDestroy(() => {
      unhandle();
      unregister();
    });
    // Links from before note URLs (/?note=<id>, in pushes already sent).
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('note');
      if (id) void this.router.navigate(['/n', id], { replaceUrl: true });
      // Shared from another app (#42, #46): a new note holding the words,
      // the link and the files.
      // Only from this device: another site's link must not plant text
      // a later Claude would read (review on #98).
      const local = this.cameFromHere();
      const shared = local
        ? sharedText(params.get('title'), params.get('text'), params.get('url'))
        : '';
      const files = local ? params.get('shared') : null;
      if (shared || files) {
        this.capture.newNote();
        this.shareNote = this.capture.open().id;
        // Written at once, not after the typing pause: the address no
        // longer holds the words once it is tidied (2026-11-14).
        if (shared) {
          this.capture.replace(shared);
          this.capture.flush();
        }
        void this.router.navigate(['/'], { replaceUrl: true }).then(() => {
          if (files === 'lost') {
            this.linkStatus.set('The shared files did not come through. Please share them again.');
          }
        });
        // Once the editor is drawn: on a cold start this runs first.
        if (files && files !== 'lost') {
          afterNextRender(() => void this.takeSharedFiles(), { injector: this.injector });
        }
      } else if (params.has('text') || params.has('shared')) {
        void this.router.navigate(['/'], { replaceUrl: true });
      }
      // A reminder's link (#40): to a template, it means a new entry.
      const routed = this.route.snapshot.paramMap.get('id');
      if (params.get('from') === 'reminder' && routed) this.entryFrom.set(routed);
    });
    // Files shared while signed out wait for the editor (review on #98).
    let drained = false;
    effect(() => {
      if (drained || !this.editor()) return;
      drained = true;
      untracked(() => void this.takeSharedFiles());
    });
    effect(() => {
      const id = this.entryFrom();
      if (!id || !this.notes.loaded()) return;
      // Kept until the note arrives: a template not synced here yet still
      // gets its entry when it does (review on #96).
      const note = this.notes.find(id);
      if (!note) return;
      untracked(() => {
        this.entryFrom.set(undefined);
        if (note.kind === 'template') void this.fromTemplate(id, { replaceUrl: true });
      });
    });

    // A tap outside More closes it; outside Right Now's sheet, that too.
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.('.more')) this.moreOpen.set(false);
      if (!target?.closest?.('.right-now')) this.rightNowOpen.set(false);
    };
    document.addEventListener('pointerdown', outside);
    // Escape closes More wherever the cursor is: the note takes the
    // cursor when it loads, and a menu left open then could not be
    // closed from the keyboard. Inside More its own handler runs too,
    // and returns to the button.
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.moreOpen()) this.moreOpen.set(false);
      // Right Now's sheet, likewise, wherever the focus is (#287); back
      // on its line. Nothing else's Escape is taken.
      if (event.key === 'Escape' && this.rightNowOpen()) this.closeRightNow();
    };
    document.addEventListener('keydown', escape);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    });

    // Wide screens (900 px and up): the notes beside the note, Right Now in the rail (#289).
    const wide = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : undefined;
    if (wide) {
      const onWide = () => this.wide.set(wide.matches);
      onWide();
      wide.addEventListener?.('change', onWide);
      inject(DestroyRef).onDestroy(() => wide.removeEventListener?.('change', onWide));
    }

    const update = () => this.online.set(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    });
  }

  /**
   * The note the URL names, as this screen shows it: New's rewrite of
   * the old entry (`holdRoute`) passes it by, so New goes straight to
   * the capture screen's layout, never through line mode (#287).
   */
  private readonly noteRoute = signal<string | undefined>(undefined);
  /**
   * The window is 900 px or wider: the notes list beside the note, and
   * no Right Now panel, it being the rail's entry (#289, 2026-11-16).
   */
  protected readonly wide = signal(false);
  /**
   * Right Now as one line (Eric, 2026-11-15, #287): on a phone, while
   * the screen shows a saved note, that is a note the URL names
   * (`/n/<id>`). The capture screen at `/` keeps the panel and its
   * handle, even once what is typed there is saved, so the layout never
   * moves under typing.
   */
  protected readonly lineMode = computed(() => !!this.noteRoute() && !this.wide());
  /** Right Now's sheet is open over the note (line mode only). */
  protected readonly rightNowOpen = signal(false);
  private readonly fresh = inject(FreshCounts);
  /** The one line: how many are due and the first, or what is new. */
  protected readonly line = computed(() =>
    rightNowLine(
      this.reminders.due().map((r) => r.text),
      // The same numbers as Right Now's own foot line (#288).
      this.fresh.reader(),
      this.fresh.podcasts(),
    ),
  );
  /**
   * The on-screen keyboard is up over the note (the ribbon's reading of
   * it): the Right Now line and a folded header give the note the room.
   */
  protected readonly keyboardUp = computed(() => this.editor()?.keyboardUp() ?? false);
  /** Phones only: on wide screens nothing steps aside for the keyboard. */
  protected readonly giveRoom = computed(() => this.keyboardUp() && !this.wide());

  private readonly lineButton = viewChild<ElementRef<HTMLButtonElement>>('lineButton');
  private readonly sheet = viewChild<ElementRef<HTMLElement>>('sheet');
  /**
   * The focus is in the sheet: the index of the Done that has it, or -1
   * for anything else there; undefined when it is not in the sheet.
   */
  private sheetFocus?: number;

  /** The line opens or closes the sheet; open, the focus goes into it. */
  protected toggleRightNow(): void {
    if (this.rightNowOpen()) {
      this.closeRightNow();
      return;
    }
    this.rightNowOpen.set(true);
    this.sheetFocus = undefined;
    afterNextRender(
      () => this.sheet()?.nativeElement.querySelector<HTMLElement>('a, button')?.focus(),
      {
        injector: this.injector,
      },
    );
  }

  /** Closes Right Now's sheet, the focus back on its line if it was in it. */
  protected closeRightNow(): void {
    if (!this.rightNowOpen()) return;
    const active = this.doc.activeElement;
    const inside =
      !active || active === this.doc.body || !!this.sheet()?.nativeElement.contains(active);
    this.rightNowOpen.set(false);
    if (inside) this.lineButton()?.nativeElement.focus();
  }

  /** Where in the sheet the focus is, for when its row goes. */
  protected sheetFocusIn(event: FocusEvent): void {
    this.sheetFocus = this.sheetDones().indexOf(event.target as HTMLElement);
  }

  /** Focus that moves out of the sheet to something else is not kept. */
  protected sheetFocusOut(event: FocusEvent): void {
    const to = event.relatedTarget as Node | null;
    if (to && !this.sheet()?.nativeElement.contains(to)) this.sheetFocus = undefined;
  }

  private sheetDones(): HTMLElement[] {
    return [
      ...(this.sheet()?.nativeElement.querySelectorAll<HTMLElement>(
        'button[aria-label^="Done: "]',
      ) ?? []),
    ];
  }

  /** A Done that had the focus went with its row: the focus stays in the sheet. */
  private keepSheetFocus(): void {
    const sheet = this.sheet()?.nativeElement;
    const active = this.doc.activeElement;
    if (!sheet || this.sheetFocus === undefined) return;
    if (active && active !== this.doc.body && active.isConnected) return;
    const dones = this.sheetDones();
    const next =
      this.sheetFocus >= 0 ? dones[Math.min(this.sheetFocus, dones.length - 1)] : undefined;
    (next ?? sheet.querySelector<HTMLElement>('a, button'))?.focus();
  }

  private readonly pickList = viewChildren<ElementRef<HTMLElement>>('pickList');

  /**
   * Previous note or Projects, chosen in More (2026-11-15, #287): its
   * list opens above the note, the focus on its first item.
   */
  protected showList(which: 'previous' | 'projects'): void {
    this.previousOpen.set(which === 'previous');
    this.projectsOpen.set(which === 'projects');
    afterNextRender(() => this.pickList()[0]?.nativeElement.querySelector('button')?.focus(), {
      injector: this.injector,
    });
  }

  protected closeLists(): void {
    this.previousOpen.set(false);
    this.projectsOpen.set(false);
  }

  /** Moved by hand while it had nothing to tend: shown as moved, this visit. */
  private readonly movedWhileEmpty = signal(false);
  /**
   * Right Now's share as shown: closed while it has nothing to tend and
   * no Undo to offer (Eric, 2026-10-18), unless moved since; else the
   * share saved here.
   */
  protected readonly share = computed(() => {
    // Open while an Undo is offered: finishing the last one must not hide it.
    const empty = this.reminders.due().length === 0 && !this.reminders.undoable();
    return empty && !this.movedWhileEmpty() ? 0 : this.split.rightNowShare();
  });
  /** The saved share when a drag began, put back if it never moved. */
  private dragFrom?: { share: number; moved: boolean; wasEmpty: boolean };

  /** Dragging the handle sets Right Now's share of the screen height. */
  protected startDrag(event: PointerEvent): void {
    const shown = this.share();
    const top = innerHeight * (1 - shown / 100);
    this.dragFrom = {
      share: this.split.rightNowShare(),
      moved: false,
      wasEmpty: !this.movedWhileEmpty(),
    };
    // From where it is shown, so the panel does not jump open first.
    this.split.preview(shown);
    this.movedWhileEmpty.set(true);
    // Keep the grip under the finger: no jump on the first move.
    this.grabOffset = event.clientY - top;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  protected drag(event: PointerEvent): void {
    if (this.grabOffset === null) return;
    const top = event.clientY - this.grabOffset;
    if (this.dragFrom) this.dragFrom.moved = true;
    this.split.preview(((innerHeight - top) / innerHeight) * 100);
  }

  /** Saved once, when the drag ends, not on every move. */
  protected endDrag(event: PointerEvent): void {
    if (this.grabOffset === null) return;
    this.grabOffset = null;
    const from = this.dragFrom;
    this.dragFrom = undefined;
    if (from && !from.moved) {
      // A tap, not a drag: nothing changes, nothing is saved.
      this.split.preview(from.share);
      if (from.wasEmpty) this.movedWhileEmpty.set(false);
    } else {
      this.split.set(this.split.rightNowShare());
    }
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  /** Arrow, Home and End keys move the handle too, as for any separator. */
  protected nudge(event: KeyboardEvent): void {
    const share = this.share();
    const next = {
      ArrowUp: share + 5,
      ArrowDown: share - 5,
      Home: MAX_SHARE,
      End: MIN_SHARE,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    this.movedWhileEmpty.set(true);
    this.split.set(next);
  }

  /**
   * The place's scroll and caret, once the note's text is in the editor;
   * false until then. A note not here or sealed here waits: the launch
   * goes Home from it instead.
   */
  private restorePlace(spot: Spot): boolean {
    const editor = this.editor();
    if (!editor || !this.notes.loaded() || this.waiting() || this.locked()) return false;
    if (!editor.shows(this.capture.current())) return false;
    // Not before the note's text is in the editor: the notes can load
    // a moment before the capture note's text merges in, and an empty
    // editor "shows" the empty text it has then, so the scroll would
    // land on nothing and the caret at 0, and the restore end there.
    const rec = this.record();
    if (spot.saved && !rec) return false;
    if (rec && !rec.locked && rec.body.trim() && !this.capture.current().trim()) return false;
    editor.restorePlace(spot.top ?? 0, spot.caret);
    return true;
  }

  /**
   * A fresh capture note at `/` (New note in the top bar, #272). When
   * leaving the old capture note, its history entry becomes that note's
   * own URL, so back returns to it. On `/` with nothing written yet it
   * stays, the cursor in it: that is a new note already.
   */
  protected async newNote(): Promise<void> {
    this.previousOpen.set(false);
    this.projectsOpen.set(false);
    this.templatesOpen.set(false);
    if (!this.routeId() && !this.locked() && !this.capture.current().trim()) {
      this.back.set(false);
      this.editor()?.focus();
      return;
    }
    // Saved first, so a note typed a moment ago exists and keeps its URL.
    this.capture.flush();
    const old = this.capture.open().id;
    const rewrite = !this.routeId() && this.notes.exists(old);
    // The fresh note and its cursor come first, before any navigation,
    // so typing straight after New lands in it (never a keystroke lost).
    this.capture.newNote();
    this.editor()?.load(this.capture.open().id, '');
    this.editor()?.focus();
    if (rewrite) {
      // Only the history entry changes; the open note stays the new one.
      this.holdRoute = old;
      try {
        await this.router.navigate(['/n', old], { replaceUrl: true });
      } finally {
        this.holdRoute = undefined;
      }
    }
    await this.router.navigate(['/']);
  }

  /** Opens a template's note: its living note, or a fresh entry (#38). */
  protected async fromTemplate(
    templateId: string,
    { replaceUrl = false }: { replaceUrl?: boolean } = {},
  ): Promise<void> {
    this.templatesOpen.set(false);
    const note = this.templates.use(templateId);
    if (!note) return;
    this.capture.openNote(note.id, note.text);
    this.editor()?.load(note.id, note.text);
    this.editor()?.focus();
    await this.router.navigate(['/n', note.id], { replaceUrl });
  }

  /** After a choice in More that stays here, the cursor goes back to the note. */
  protected backToNote(): void {
    this.moreOpen.set(false);
    this.editor()?.focus();
  }

  /** Escape closes More and returns to its button. */
  protected closeMore(button: HTMLButtonElement): void {
    this.moreOpen.set(false);
    button.focus();
  }

  /**
   * A concept just became a project (#41): its text gains the project
   * sections, keeping what was written under Overview.
   */
  protected addProjectSections(): void {
    this.capture.replace(withProjectSections(this.capture.current()));
  }

  /** Files sw.js kept from a share go into the new note (#46). */
  /** One take at a time, so two callers never split a share. */
  private taking = Promise.resolve();

  private takeSharedFiles(): Promise<void> {
    this.taking = this.taking
      .then(() => this.takeShared())
      .catch((err) => console.error('shared files not taken', err));
    return this.taking;
  }

  private async takeShared(): Promise<void> {
    // Signed out there is no note to put them in: they wait in the inbox,
    // taken when the editor first shows (review on #98).
    const editor = this.editor();
    if (!editor) return;
    const files = await this.shareInbox.take();
    if (!files.length) return;
    // Into the note the share made, or a new one: never another note.
    if (this.capture.open().id !== this.shareNote) {
      this.capture.newNote();
      this.shareNote = this.capture.open().id;
      void this.router.navigate(['/'], { replaceUrl: true });
    }
    await editor.addFiles(files);
  }

  /** The page was opened by this app or the share sheet, not another site. */
  private cameFromHere(): boolean {
    if (!this.doc.referrer) return true;
    const from = new URL(this.doc.referrer);
    // An app's referrer (android-app://...) is this device, not a site.
    if (from.protocol !== 'http:' && from.protocol !== 'https:') return true;
    return from.origin === this.doc.location.origin;
  }

  /** A tick or Done shopping in the list view. */
  protected listChange(change: { body: string; keep: boolean }): void {
    // Done shopping on the grocery list: where its items were filed is
    // kept first, for the next week's dinners (#130).
    if (change.keep && this.record()?.id === this.grocery.listId()) {
      this.grocery.remember(listSections(this.capture.current()));
      // What was bought is on hand now (#131).
      this.grocery.bought(this.capture.current());
    }
    this.capture.replace(change.body, { keep: change.keep });
  }

  /**
   * Viewing or editing, remembered for this note. Back to editing, the
   * keyboard waits for a tap where the typing is to go.
   */
  protected toggleViewing(): void {
    this.modes.setViewing(this.capture.open().id, !this.viewing());
  }

  protected openPrevious(id: string): void {
    this.previousOpen.set(false);
    this.projectsOpen.set(false);
    void this.router.navigate(['/n', id]);
  }

  /**
   * A tapped `[[link]]` opens its note, pushing history like any other
   * note. A name nothing answers to becomes a concept first.
   */
  protected followLink(target: string): void {
    this.capture.flush();
    const id = this.notes.names().get(normalizeName(target)) ?? this.notes.createConcept(target);
    void this.router.navigate(['/n', id]);
  }

  /** Copies this note's address, to open it from anywhere. */
  protected async copyLink(): Promise<void> {
    const url = `${location.origin}/n/${this.capture.open().id}`;
    try {
      await navigator.clipboard.writeText(url);
      this.linkStatus.set('Link copied');
    } catch {
      this.linkStatus.set(`Could not copy; the link is ${url}`);
    }
  }
}
