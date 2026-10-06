import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';

/** What a signed-out visitor sees instead of the editor. */
@Component({
  selector: 'app-sign-in',
  imports: [RouterLink],
  template: `
    <main class="page sign-in">
      <h1>Mossgoblin</h1>
      <p class="muted">Plant a thought; the goblin keeps it.</p>
      <button type="button" class="primary" (click)="signIn()">Sign in with Google</button>
      @if (auth.usingEmulators) {
        <p><a routerLink="/dev-sign-in">Dev sign-in</a></p>
      }
    </main>
  `,
  styles: `
    .sign-in {
      display: grid;
      gap: 16px;
      justify-items: start;
      padding-top: 20dvh;
    }
    h1 {
      margin: 0;
    }
    .muted {
      color: var(--quiet);
      margin: 0;
    }
    .primary {
      font: inherit;
      padding: 12px 20px;
      border: 0;
      border-radius: var(--radius-control);
      color: var(--on-accent);
      background: var(--accent);
      cursor: pointer;
    }
  `,
})
export class SignIn {
  protected readonly auth = inject(AuthService);

  protected signIn(): void {
    this.auth.signInWithGoogle().catch((err) => console.error(err));
  }
}
