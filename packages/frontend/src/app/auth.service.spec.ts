import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AUTH_API, AuthApi, AuthService } from './auth.service';
import { FIREBASE } from './firebase';
import { fakeFirebase } from './testing/fakes';

function setup(usingEmulators: boolean) {
  let emit: (u: User | null) => void = () => undefined;
  const api: AuthApi = {
    onAuthStateChanged: vi.fn((_a, next) => (emit = next)),
    signInWithPopup: vi.fn(() => Promise.resolve()),
    signInWithEmailAndPassword: vi.fn(() => Promise.resolve()),
    signOut: vi.fn(() => Promise.resolve()),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(usingEmulators) },
      { provide: AUTH_API, useValue: api },
    ],
  });
  return { service: TestBed.inject(AuthService), api, emit: (u: User | null) => emit(u) };
}

describe('AuthService', () => {
  it('is undefined until the persisted session resolves, then follows it', () => {
    const { service, emit } = setup(false);
    expect(service.user()).toBeUndefined();
    emit({ uid: 'u1' } as User);
    expect(service.user()?.uid).toBe('u1');
    emit(null);
    expect(service.user()).toBeNull();
  });

  it('remembers on the device that it has been signed in', () => {
    localStorage.clear();
    const { service, emit } = setup(false);
    expect(service.signedInBefore()).toBe(false);
    emit({ uid: 'u1' } as User);
    expect(localStorage.getItem('goblin.signedIn')).toBe('true');
    TestBed.resetTestingModule();
    const again = setup(false);
    expect(again.service.signedInBefore()).toBe(true);
    again.emit(null);
    expect(again.service.signedInBefore()).toBe(false);
    expect(localStorage.getItem('goblin.signedIn')).toBeNull();
  });

  it('signs in with the Google popup', async () => {
    const { service, api } = setup(false);
    await service.signInWithGoogle();
    expect(api.signInWithPopup).toHaveBeenCalledOnce();
  });

  it('refuses dev sign-in outside the emulator', async () => {
    const { service, api } = setup(false);
    await expect(service.signInForDev('a@b.c', 'pw')).rejects.toThrow('emulator-only');
    expect(api.signInWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it('allows dev sign-in against the emulator', async () => {
    const { service, api } = setup(true);
    await service.signInForDev('a@b.c', 'pw');
    expect(api.signInWithEmailAndPassword).toHaveBeenCalledWith({}, 'a@b.c', 'pw');
  });

  it('signs out', async () => {
    const { service, api } = setup(false);
    await service.signOut();
    expect(api.signOut).toHaveBeenCalledOnce();
  });
});
