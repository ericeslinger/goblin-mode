import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';
import { NoteList } from '../browse/note-list';
import { CaptureService } from '../capture/capture.service';
import { NotesService } from '../notes/notes.service';
import { SignIn } from '../sign-in/sign-in';
import { EditorModeService } from '../note-editor/editor-mode.service';
import { NoteEditorComponent } from '../note-editor/note-editor';
import { RightNowPanel } from '../reminders/right-now-panel';
import { MAX_SHARE, MIN_SHARE, SplitService } from '../split/split.service';

/**
 * The launch screen: a cursor in a note on top, Right Now below, and
 * on wide screens the notes list beside it, with Right Now on top of
 * the list. Signed out, only sign-in.
 */
@Component({
  selector: 'app-launch',
  imports: [RouterLink, NoteEditorComponent, NoteList, RightNowPanel, SignIn],
  templateUrl: './launch.html',
  styleUrl: './launch.css',
})
export class Launch {
  protected readonly auth = inject(AuthService);
  protected readonly capture = inject(CaptureService);
  private readonly notes = inject(NotesService);
  private readonly router = inject(Router);
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

  protected readonly previousOpen = signal(false);
  /** The few most recent other notes, for "Previous note". */
  protected readonly previous = computed(() =>
    this.notes
      .notes()
      .filter((n) => !n.archived && n.body.trim() && n.id !== this.capture.open().id)
      .slice(0, 5),
  );

  constructor() {
    // A link to /?note=<id> (the notes list) opens that note here.
    inject(ActivatedRoute)
      .queryParamMap.pipe(takeUntilDestroyed())
      .subscribe((params) => {
        const id = params.get('note');
        if (!id) return;
        this.capture.openNote(id);
        void this.router.navigate([], { queryParams: {}, replaceUrl: true });
      });

    const update = () => this.online.set(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    });
  }

  /** Dragging the handle sets Right Now's share of the screen height. */
  protected startDrag(event: PointerEvent): void {
    const top = innerHeight * (1 - this.split.rightNowShare() / 100);
    // Keep the grip under the finger: no jump on the first move.
    this.grabOffset = event.clientY - top;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  protected drag(event: PointerEvent): void {
    if (this.grabOffset === null) return;
    const top = event.clientY - this.grabOffset;
    this.split.preview(((innerHeight - top) / innerHeight) * 100);
  }

  /** Saved once, when the drag ends, not on every move. */
  protected endDrag(event: PointerEvent): void {
    if (this.grabOffset === null) return;
    this.grabOffset = null;
    this.split.set(this.split.rightNowShare());
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  /** Arrow, Home and End keys move the handle too, as for any separator. */
  protected nudge(event: KeyboardEvent): void {
    const share = this.split.rightNowShare();
    const next = {
      ArrowUp: share + 5,
      ArrowDown: share - 5,
      Home: MAX_SHARE,
      End: MIN_SHARE,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    this.split.set(next);
  }

  protected newNote(): void {
    this.previousOpen.set(false);
    this.capture.newNote();
  }

  protected openPrevious(id: string): void {
    this.previousOpen.set(false);
    this.capture.openNote(id);
  }
}
