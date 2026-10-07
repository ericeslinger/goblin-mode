import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../auth.service';
import { NotesService } from '../notes/notes.service';
import { FakeAuthService, FakeNotes, noteRecord } from '../testing/fakes';
import { CLAUDE_ACCESS_API } from '../claude/claude-access';
import { type PushState, PushService } from '../push/push.service';
import { Settings } from './settings';

function fakePush(state: PushState = 'off') {
  return {
    state: signal<PushState>(state),
    error: signal(''),
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    beforeSignOut: vi.fn(async () => undefined),
  };
}

const claude = { consent: vi.fn(), approve: vi.fn(), revoke: vi.fn(async () => 2), go: vi.fn() };

async function render(auth: FakeAuthService, push = fakePush(), notes = new FakeNotes()) {
  await TestBed.configureTestingModule({
    imports: [Settings],
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: PushService, useValue: push },
      { provide: CLAUDE_ACCESS_API, useValue: claude },
      { provide: NotesService, useValue: notes },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Settings);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('Settings', () => {
  it('shows who is signed in and the build stamp', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const el = await render(auth);
    expect(el.textContent).toContain('Signed in as eric@example.com');
    expect(el.textContent).toContain('Version');
    expect(el.textContent).toContain('dev');
  });

  it('says so when signed out', async () => {
    const el = await render(new FakeAuthService());
    expect(el.textContent).toContain('Not signed in.');
  });

  it('turns notifications on and off', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const push = fakePush('off');
    const el = await render(auth, push);
    expect(el.textContent).toContain('Reminders are not sent to this device.');
    button(el, 'Turn on notifications')!.click();
    expect(push.enable).toHaveBeenCalled();

    push.state.set('on');
    TestBed.tick();
    expect(el.textContent).toContain('Reminders are sent to this device.');
    button(el, 'Turn off notifications')!.click();
    expect(push.disable).toHaveBeenCalled();
  });

  it('turns this device off before signing out', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const push = fakePush('on');
    const order: string[] = [];
    push.beforeSignOut.mockImplementation(async () => void order.push('push'));
    auth.signOut.mockImplementation(async () => void order.push('auth'));
    const el = await render(auth, push);
    button(el, 'Sign out')!.click();
    await vi.waitFor(() => expect(order).toEqual(['push', 'auth']));
  });

  it('explains when notifications cannot be turned on', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const el = await render(auth, fakePush('blocked'));
    expect(el.textContent).toContain('Notifications are blocked for this site.');
    expect(button(el, 'Turn on notifications')).toBeUndefined();
  });

  it('shows no notification controls when signed out', async () => {
    const el = await render(new FakeAuthService());
    expect(el.textContent).not.toContain('Notifications');
  });

  it('shows the connector URL and disconnects Claude', async () => {
    const auth = new FakeAuthService();
    auth.user.set({ email: 'e@x.test', getIdToken: async () => 'id-token' } as never);
    const el = await render(auth);
    expect(el.querySelector('code')?.textContent).toBe(`${location.origin}/mcp`);
    button(el, 'Disconnect Claude')!.click();
    await vi.waitFor(() => expect(claude.revoke).toHaveBeenCalledWith('id-token'));
    TestBed.tick();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(el.textContent).toContain('Claude is disconnected.');
    });
  });

  it('lists templates and makes new ones, opening them to write', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const notes = new FakeNotes();
    notes.signIn([
      { ...noteRecord('t1', 'Shopping list'), kind: 'template', templateMode: 'living' },
      { ...noteRecord('t2', 'Journal'), kind: 'template' },
      noteRecord('n1', 'Not a template'),
    ]);
    const el = await render(auth, fakePush(), notes);
    const list = el.querySelector('[aria-labelledby="templates"]')!;
    const rows = [...list.querySelectorAll('li')].map((li) => [
      li.querySelector('a')!.textContent!.trim(),
      li.querySelector('a')!.getAttribute('href'),
      li.querySelector('.muted')!.textContent!.trim(),
    ]);
    expect(rows).toEqual([
      ['Journal', '/n/t2', 'a new note each time'],
      ['Shopping list', '/n/t1', 'one note, reused'],
    ]);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    button(el, 'New living template')!.click();
    expect(notes.create).toHaveBeenCalledWith(
      'new1',
      expect.stringContaining('## Instructions for Claude'),
      {
        kind: 'template',
        templateMode: 'living',
      },
    );
    expect(navigate).toHaveBeenCalledWith(['/n', 'new1']);
  });
});
