import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../auth.service';
import { FakeAuthService } from '../testing/fakes';
import { DevSignIn } from './dev-sign-in';

async function render(auth: FakeAuthService) {
  await TestBed.configureTestingModule({
    imports: [DevSignIn],
    providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
  }).compileComponents();
  const fixture = TestBed.createComponent(DevSignIn);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('DevSignIn', () => {
  it('signs in with the typed credentials and goes home', async () => {
    const auth = new FakeAuthService();
    const { el, fixture } = await render(auth);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    (el.querySelector('input[name=email]') as HTMLInputElement).value = 'a@b.c';
    (el.querySelector('input[name=password]') as HTMLInputElement).value = 'pw';
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(auth.signInForDev).toHaveBeenCalledWith('a@b.c', 'pw');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows the error when sign-in fails', async () => {
    const auth = new FakeAuthService();
    auth.signInForDev.mockRejectedValueOnce(new Error('bad password'));
    const { el, fixture } = await render(auth);
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('bad password');
  });

  it('is unavailable outside the emulator', async () => {
    const auth = new FakeAuthService();
    auth.usingEmulators = false;
    const { el } = await render(auth);
    expect(el.querySelector('form')).toBeNull();
    expect(el.textContent).toContain('only available against the emulators');
  });
});
