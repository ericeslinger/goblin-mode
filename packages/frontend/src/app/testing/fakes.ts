// Spec-support helpers; never imported from production code.
import { signal } from '@angular/core';
import type { User } from 'firebase/auth';
import type { FirebaseHandles } from '../firebase';

export function fakeFirebase(usingEmulators: boolean): FirebaseHandles {
  return { app: {}, auth: {}, db: {}, usingEmulators } as unknown as FirebaseHandles;
}

/** A stand-in for AuthService with a settable user. */
export class FakeAuthService {
  readonly user = signal<User | null | undefined>(null);
  usingEmulators = true;
  signInWithGoogle = vi.fn(() => Promise.resolve());
  signInForDev = vi.fn((_email: string, _password: string) => Promise.resolve());
  signOut = vi.fn(() => Promise.resolve());

  signInAs(email: string): void {
    this.user.set({ email } as User);
  }
}
