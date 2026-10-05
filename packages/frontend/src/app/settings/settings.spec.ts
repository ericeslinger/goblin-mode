import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../auth.service';
import { FakeAuthService } from '../testing/fakes';
import { Settings } from './settings';

async function render(auth: FakeAuthService) {
  await TestBed.configureTestingModule({
    imports: [Settings],
    providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
  }).compileComponents();
  const fixture = TestBed.createComponent(Settings);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

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
});
