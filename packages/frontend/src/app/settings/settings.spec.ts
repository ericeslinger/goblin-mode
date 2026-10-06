import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../auth.service';
import { FakeAuthService } from '../testing/fakes';
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

async function render(auth: FakeAuthService, push = fakePush()) {
  await TestBed.configureTestingModule({
    imports: [Settings],
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: PushService, useValue: push },
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
});
