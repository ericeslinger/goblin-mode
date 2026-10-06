import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';
import { EditorModeService } from '../note-editor/editor-mode.service';
import { NoteEditorComponent } from '../note-editor/note-editor';
import { SplitService } from '../split/split.service';

/**
 * The launch screen: a cursor in a new note on top, Right Now below.
 * Scaffold only: the editor does not save yet (build order step 3).
 */
@Component({
  selector: 'app-launch',
  imports: [RouterLink, NoteEditorComponent],
  templateUrl: './launch.html',
  styleUrl: './launch.css',
})
export class Launch {
  protected readonly auth = inject(AuthService);
  protected readonly modes = inject(EditorModeService);
  protected readonly online = signal(navigator.onLine);
  protected readonly split = inject(SplitService);
  private dragging = false;

  constructor() {
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
    this.dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  protected drag(event: PointerEvent): void {
    if (!this.dragging) return;
    this.split.set(((innerHeight - event.clientY) / innerHeight) * 100);
  }

  protected endDrag(event: PointerEvent): void {
    this.dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  /** Arrow keys move the handle too, for keyboard and switch users. */
  protected nudge(event: KeyboardEvent): void {
    const step = { ArrowUp: 5, ArrowDown: -5 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    this.split.set(this.split.rightNowShare() + step);
  }

  protected signIn(): void {
    this.auth.signInWithGoogle().catch((err) => console.error(err));
  }
}
