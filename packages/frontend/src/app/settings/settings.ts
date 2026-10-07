import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';
import { buildInfo } from '../build-info';
import { CLAUDE_ACCESS_API } from '../claude/claude-access';
import { type PushState, PushService } from '../push/push.service';
import { TemplatesService } from '../templates/templates.service';
import { ThemePicker } from '../theme/theme-picker';

@Component({
  selector: 'app-settings',
  imports: [RouterLink, ThemePicker],
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
      <h2>Appearance</h2>
      <app-theme-picker />
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
      @if (auth.user()) {
        <h2 id="templates">Templates</h2>
        <p>
          A template is a note to start others from, with an Instructions for Claude section that
          tells Claude how to fill them in.
        </p>
        @if (templates.templates().length) {
          <ul aria-labelledby="templates" class="templates">
            @for (t of templates.templates(); track t.id) {
              <li>
                <a [routerLink]="['/n', t.id]">{{ t.title || 'Untitled' }}</a>
                <span class="muted">{{
                  t.templateMode === 'living' ? 'one note, reused' : 'a new note each time'
                }}</span>
              </li>
            }
          </ul>
        }
        <div class="actions">
          <button type="button" (click)="newTemplate('entry')">New template</button>
          <button type="button" (click)="newTemplate('living')">New living template</button>
        </div>
      }
      @if (auth.user()) {
        <h2>Claude</h2>
        <p>
          To let Claude read and change your notes, add a custom connector in claude.ai (Settings,
          Connectors) with this URL:
        </p>
        <p>
          <code>{{ mcpUrl }}</code>
        </p>
        <p><a routerLink="/activity">What Claude changed</a></p>
        <button type="button" (click)="disconnect()">Disconnect Claude</button>
        @if (claudeStatus()) {
          <p role="status">{{ claudeStatus() }}</p>
        }
      }
      <h2>Version</h2>
      <p>{{ build.sha }} &middot; {{ build.time }}</p>
    </main>
  `,
  styles: `
    .templates {
      list-style: none;
      padding: 0;
    }
    .templates li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      padding: 2px 0;
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
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

  protected readonly templates = inject(TemplatesService);
  private readonly router = inject(Router);

  /** Makes a template and opens it to be written. */
  protected newTemplate(mode: 'living' | 'entry'): void {
    void this.router.navigate(['/n', this.templates.create(mode)]);
  }

  protected readonly mcpUrl = `${location.origin}/mcp`;
  protected readonly claudeStatus = signal('');
  private readonly claude = inject(CLAUDE_ACCESS_API);

  /** Drops every token Claude holds; claude.ai must connect again. */
  protected async disconnect(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      const n = await this.claude.revoke(await user.getIdToken());
      this.claudeStatus.set(n ? 'Claude is disconnected.' : 'Claude was not connected.');
    } catch (err) {
      this.claudeStatus.set(`Could not disconnect: ${(err as Error).message}`);
    }
  }

  protected async signOut(): Promise<void> {
    await this.push.beforeSignOut();
    await this.auth.signOut();
  }
}
