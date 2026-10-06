import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';
import { EditorModeService } from '../note-editor/editor-mode.service';
import { NoteEditorComponent } from '../note-editor/note-editor';

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

  constructor() {
    const update = () => this.online.set(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    });
  }

  protected signIn(): void {
    this.auth.signInWithGoogle().catch((err) => console.error(err));
  }
}
