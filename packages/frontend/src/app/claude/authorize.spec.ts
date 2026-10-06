import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FakeAuthService } from '../testing/fakes';
import { Authorize } from './authorize';
import { CLAUDE_ACCESS_API, type ClaudeAccessApi } from './claude-access';

const QUERY =
  'response_type=code&client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback' +
  '&code_challenge=abc&code_challenge_method=S256&state=s1';

async function render(api: Partial<ClaudeAccessApi>, signedIn = true) {
  const auth = new FakeAuthService();
  auth.user.set(
    signedIn ? ({ uid: 'owner', getIdToken: async () => 'id-token' } as unknown as User) : null,
  );
  const full = {
    consent: vi.fn(async () => ({ clientName: 'Claude', redirectOrigin: 'https://claude.ai' })),
    approve: vi.fn(async () => 'https://claude.ai/api/mcp/auth_callback?code=k&state=s1'),
    revoke: vi.fn(async () => 0),
    go: vi.fn(),
    ...api,
  } satisfies ClaudeAccessApi;
  await TestBed.configureTestingModule({
    imports: [Authorize],
    providers: [
      provideRouter([{ path: 'oauth/authorize', component: Authorize }]),
      { provide: AuthService, useValue: auth },
      { provide: CLAUDE_ACCESS_API, useValue: full },
    ],
  }).compileComponents();
  await TestBed.inject(Router).navigateByUrl(`/oauth/authorize?${QUERY}`);
  const fixture = TestBed.createComponent(Authorize);
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r));
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, api: full, fixture };
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('Authorize', () => {
  it('asks Eric to sign in first', async () => {
    const { el, api } = await render({}, false);
    expect(el.querySelector('app-sign-in')).toBeTruthy();
    expect(api.consent).not.toHaveBeenCalled();
  });

  it('shows who is asking, then approves with his ID token and goes back', async () => {
    const { el, api, fixture } = await render({});
    expect(api.consent).toHaveBeenCalledWith(QUERY);
    expect(el.textContent).toContain('Claude wants to read and change your notes and reminders.');
    expect(el.textContent).toContain('https://claude.ai');
    button(el, 'Allow')!.click();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    expect(api.approve).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'c1', state: 's1', code_challenge: 'abc' }),
      'id-token',
    );
    expect(api.go).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?code=k&state=s1');
  });

  it('denies by going back with access_denied', async () => {
    const { el, api } = await render({});
    button(el, 'Deny')!.click();
    expect(api.go).toHaveBeenCalledWith(
      'https://claude.ai/api/mcp/auth_callback?error=access_denied&state=s1',
    );
  });

  it('says why a request cannot be approved, and offers nothing to click', async () => {
    const { el } = await render({
      consent: vi.fn(async () => Promise.reject(new Error('unknown client'))),
    });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('unknown client');
    expect(button(el, 'Allow')).toBeUndefined();
  });
});
