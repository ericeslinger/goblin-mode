import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../auth.service';
import { FakeAuthService } from '../testing/fakes';
import { Launch } from './launch';

async function render(auth = new FakeAuthService()) {
  await TestBed.configureTestingModule({
    imports: [Launch],
    providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
  }).compileComponents();
  const fixture = TestBed.createComponent(Launch);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, auth };
}

describe('Launch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('puts the cursor in the editor', async () => {
    const { el } = await render();
    expect(document.activeElement).toBe(el.querySelector('.cm-content[aria-label="New note"]'));
  });

  it('switches between live preview and source', async () => {
    localStorage.clear();
    const { el, fixture } = await render();
    const toggle = () =>
      [...el.querySelectorAll('button')].find((b) => /Source|Preview/.test(b.textContent ?? ''))!;
    expect(toggle().textContent?.trim()).toBe('Source');
    toggle().click();
    await fixture.whenStable();
    expect(toggle().textContent?.trim()).toBe('Preview');
    expect(toggle().hasAttribute('aria-pressed')).toBe(false);
    toggle().click();
  });

  it('shows an empty Right Now', async () => {
    const { el } = await render();
    expect(el.querySelector('.right-now')?.textContent).toContain('Nothing due.');
  });

  it('offers Google sign-in only when signed out', async () => {
    const { el, fixture, auth } = await render();
    const button = () =>
      [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Sign in');
    button()!.click();
    expect(auth.signInWithGoogle).toHaveBeenCalledOnce();
    auth.signInAs('eric@example.com');
    await fixture.whenStable();
    expect(button()).toBeUndefined();
  });

  it('shows offline when the network drops', async () => {
    const { el, fixture } = await render();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await fixture.whenStable();
    expect(el.querySelector('.sync')?.textContent?.trim()).toBe('offline');
  });
});
