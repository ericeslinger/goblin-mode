import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

/**
 * Email and password sign-in against the Auth emulator, for local dev and
 * e2e journeys (which never drive the Google popup). Shows nothing useful
 * anywhere but localhost.
 */
@Component({
  selector: 'app-dev-sign-in',
  template: `
    <main class="page">
      @if (auth.usingEmulators) {
        <h1>Dev sign-in</h1>
        <form (submit)="submit($event, email.value, password.value)">
          <label>Email <input #email name="email" type="email" /></label>
          <label>Password <input #password name="password" type="password" /></label>
          <button type="submit">Sign in</button>
        </form>
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
      } @else {
        <p>Dev sign-in is only available against the emulators.</p>
      }
    </main>
  `,
})
export class DevSignIn {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly error = signal('');

  protected async submit(event: Event, email: string, password: string): Promise<void> {
    event.preventDefault();
    try {
      await this.auth.signInForDev(email, password);
      await this.router.navigateByUrl('/');
    } catch (err) {
      this.error.set(String(err));
    }
  }
}
