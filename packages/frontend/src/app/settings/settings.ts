import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';
import { buildInfo } from '../build-info';
import { type PushState, PushService } from '../push/push.service';

@Component({
  selector: 'app-settings',
  imports: [RouterLink],
  template: `
    <main class="page">
      <a routerLink="/">Back</a>
      <h1>Settings</h1>
      @if (auth.user(); as user) {
        <p>Signed in as {{ user.email }}</p>
        <button type="button" (click)="signOut()">Sign out</button>
      } @else {
        <p>Not signed in.</p>
      }
      @if (auth.user()) {
        <h2>Notifications</h2>
        <p role="status">{{ pushMessage[push.state()] }}</p>
        @if (push.state() === 'error') {
          <p class="error">{{ push.error() }}</p>
        }
        @switch (push.state()) {
          @case ('off') {
            <button type="button" (click)="push.enable()">Turn on notifications</button>
          }
          @case ('error') {
            <button type="button" (click)="push.enable()">Try again</button>
          }
          @case ('on') {
            <button type="button" (click)="push.disable()">Turn off notifications</button>
          }
        }
      }
      <h2>Version</h2>
      <p>{{ build.sha }} &middot; {{ build.time }}</p>
    </main>
  `,
})
export class Settings {
  protected readonly auth = inject(AuthService);
  protected readonly push = inject(PushService);
  protected readonly pushMessage: Record<PushState, string> = {
    checking: 'Checking…',
    unsupported: 'This browser cannot show notifications.',
    unconfigured: 'Notifications are not set up yet.',
    off: 'Reminders are not sent to this device.',
    blocked:
      'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.',
    on: 'Reminders are sent to this device.',
    working: 'One moment…',
    error: 'Could not change notifications.',
  };
  protected readonly build = buildInfo;

  protected async signOut(): Promise<void> {
    await this.push.beforeSignOut();
    await this.auth.signOut();
  }
}
