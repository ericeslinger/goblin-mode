import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';

/**
 * The launch screen: a cursor in a new note on top, Right Now below.
 * Scaffold only: the editor does not save yet (build order step 2).
 */
@Component({
  selector: 'app-launch',
  imports: [RouterLink],
  templateUrl: './launch.html',
  styleUrl: './launch.css',
})
export class Launch implements AfterViewInit {
  protected readonly auth = inject(AuthService);
  protected readonly online = signal(navigator.onLine);
  private readonly editor = viewChild.required<ElementRef<HTMLTextAreaElement>>('editor');

  constructor() {
    const update = () => this.online.set(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    });
  }

  ngAfterViewInit(): void {
    this.editor().nativeElement.focus();
  }

  protected signIn(): void {
    this.auth.signInWithGoogle().catch((err) => console.error(err));
  }
}
