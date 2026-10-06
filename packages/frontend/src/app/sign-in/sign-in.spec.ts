import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../auth.service';
import { FakeAuthService } from '../testing/fakes';
import { SignIn } from './sign-in';

async function render(auth: FakeAuthService) {
  await TestBed.configureTestingModule({
    imports: [SignIn],
    providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
  }).compileComponents();
  const fixture = TestBed.createComponent(SignIn);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('SignIn', () => {
  it('signs in with Google', async () => {
    const auth = new FakeAuthService();
    const el = await render(auth);
    el.querySelector('button')!.click();
    expect(auth.signInWithGoogle).toHaveBeenCalledOnce();
  });

  it('links dev sign-in only against the emulators', async () => {
    const auth = new FakeAuthService();
    auth.usingEmulators = false;
    expect((await render(auth)).textContent).not.toContain('Dev sign-in');
  });
});
