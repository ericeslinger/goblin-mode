import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../auth.service';
import { SignIn } from '../sign-in/sign-in';
import { CLAUDE_ACCESS_API, type Consent } from './claude-access';

/** The query parameters an authorize request carries through. */
const PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
];

/**
 * OAuth consent for the Claude connector (DESIGN.md, MCP server): claude.ai
 * sends Eric here; signed in, he allows or denies, and goes back.
 */
@Component({
  selector: 'app-authorize',
  imports: [SignIn],
  template: `
    @if (auth.user() === null) {
      <app-sign-in />
    } @else {
      <main class="page">
        <h1>Connect Claude</h1>
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        } @else if (consent(); as c) {
          <p>
            <strong>{{ c.clientName }}</strong> wants to read and change your notes and reminders.
          </p>
          <p class="muted">You will go back to {{ c.redirectOrigin }}.</p>
          <div class="actions">
            <button type="button" class="primary" [disabled]="busy()" (click)="allow()">
              Allow
            </button>
            <button type="button" class="link" [disabled]="busy()" (click)="deny()">Deny</button>
          </div>
        } @else {
          <p class="muted">Checking the request…</p>
        }
      </main>
    }
  `,
  styles: `
    .muted {
      color: var(--quiet);
    }
    .actions {
      display: flex;
      gap: 16px;
      align-items: center;
    }
    .primary {
      font: inherit;
      padding: 8px 20px;
      border: 0;
      border-radius: 999px;
      color: var(--bg);
      background: var(--accent);
      cursor: pointer;
    }
    .link {
      border: 0;
      padding: 0;
      font: inherit;
      color: var(--accent);
      background: none;
      cursor: pointer;
    }
  `,
})
export class Authorize {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(CLAUDE_ACCESS_API);
  private readonly params: Record<string, string> = {};

  protected readonly consent = signal<Consent | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  constructor() {
    const query = inject(ActivatedRoute).snapshot.queryParamMap;
    for (const name of PARAMS) {
      const value = query.get(name);
      if (value !== null) this.params[name] = value;
    }
    // Ask who is asking once Eric is signed in.
    effect(() => {
      if (!this.auth.user()) return;
      untracked(() => void this.check());
    });
  }

  private async check(): Promise<void> {
    if (this.consent() || this.error()) return;
    try {
      this.consent.set(await this.api.consent(new URLSearchParams(this.params).toString()));
    } catch (err) {
      this.error.set(`This request cannot be approved: ${(err as Error).message}`);
    }
  }

  protected async allow(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    this.busy.set(true);
    try {
      this.api.go(await this.api.approve(this.params, await user.getIdToken()));
    } catch (err) {
      this.error.set((err as Error).message);
      this.busy.set(false);
    }
  }

  /** Back to claude.ai with access_denied; only after the request checked out. */
  protected deny(): void {
    const url = new URL(this.params['redirect_uri']);
    url.searchParams.set('error', 'access_denied');
    if (this.params['state']) url.searchParams.set('state', this.params['state']);
    this.api.go(url.toString());
  }
}
