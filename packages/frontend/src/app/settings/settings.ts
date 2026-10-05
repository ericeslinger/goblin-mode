import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';
import { buildInfo } from '../build-info';

@Component({
  selector: 'app-settings',
  imports: [RouterLink],
  template: `
    <main class="page">
      <a routerLink="/">Back</a>
      <h1>Settings</h1>
      @if (auth.user(); as user) {
        <p>Signed in as {{ user.email }}</p>
        <button type="button" (click)="auth.signOut()">Sign out</button>
      } @else {
        <p>Not signed in.</p>
      }
      <h2>Version</h2>
      <p>{{ build.sha }} &middot; {{ build.time }}</p>
    </main>
  `,
})
export class Settings {
  protected readonly auth = inject(AuthService);
  protected readonly build = buildInfo;
}
