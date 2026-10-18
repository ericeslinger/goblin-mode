import {
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  CONCEPT_PREFIX,
  CONTEXT_ID,
  CONTEXT_MAX,
  templateParts,
  checklist,
  normalizeName,
  suggestLinks,
  suggestMoods,
  withProjectSections,
} from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { projectTree } from '../browse/lenses';
import { NoteList } from '../browse/note-list';
import { ConceptHeader } from '../links/concept-header';
import { NoteBack } from '../back/note-back';
import { CaptureService } from '../capture/capture.service';
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
 * on wide screens the notes list beside it, with Right Now on top of
 * the list. Signed out, only sign-in.
 */
@Component({
  selector: 'app-launch',
  imports: [
    RouterLink,
    ConceptHeader,
    NoteEditorComponent,
    NoteBack,
    NoteList,
    RightNowPanel,
    ListView,
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
  private readonly route = inject(ActivatedRoute);
  protected readonly modes = inject(EditorModeService);
  protected readonly online = signal(navigator.onLine);
  protected readonly split = inject(SplitService);
  protected readonly minShare = MIN_SHARE;
  protected readonly maxShare = MAX_SHARE;
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
  /** A list made from a template (#39): it can be shopped from in the list view. */
  protected readonly listable = computed(
    () => !!this.record()?.fromTemplate && checklist(this.capture.current()).length > 0,
  );
  protected readonly listMode = signal(false);
  /** The URL names the context note (#113), made on first open. */
  protected readonly routeIsContext = computed(() => this.routeId() === CONTEXT_ID);
  /** The URL names a concept (its id is derived from its name). */
  protected readonly routeIsConcept = computed(() => !!this.routeId()?.startsWith(CONCEPT_PREFIX));

  /** Names a `[[` can complete to: concepts, synonyms, note titles. */
  protected readonly suggest = (query: string) => suggestLinks(query, this.notes.notes());
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
  private readonly modules = inject(ModulesService);
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
          n.body.trim() &&
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
      untracked(() => this.back.set(false));
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
    // Back after five minutes away opens a fresh capture note; the URL
    // follows, so a reload or back does not land on the old note.
    let renewed = untracked(this.capture.renewed);
    effect(() => {
      const n = this.capture.renewed();
      if (n === renewed) return;
      renewed = n;
      if (untracked(this.routeId)) void this.router.navigate(['/'], { replaceUrl: true });
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
        if (shared) this.capture.replace(shared);
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

    // A tap outside More closes it.
    const outside = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.('.more')) this.moreOpen.set(false);
    };
    document.addEventListener('pointerdown', outside);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('pointerdown', outside));

    const update = () => this.online.set(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    });
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
   * A fresh capture note at `/`. When leaving the old capture note, its
   * history entry becomes that note's own URL, so back returns to it.
   */
  protected async newNote(): Promise<void> {
    this.previousOpen.set(false);
    this.projectsOpen.set(false);
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
