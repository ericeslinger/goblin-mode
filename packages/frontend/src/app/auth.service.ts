import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import {
  Auth,
  GoogleAuthProvider,
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { FIREBASE } from './firebase';

/** The Firebase Auth calls the service makes, as a seam for unit specs. */
export interface AuthApi {
  onAuthStateChanged(auth: Auth, next: (user: User | null) => void): unknown;
  signInWithPopup(auth: Auth, provider: GoogleAuthProvider): Promise<unknown>;
  signInWithEmailAndPassword(auth: Auth, email: string, password: string): Promise<unknown>;
  signOut(auth: Auth): Promise<void>;
}

export const AUTH_API = new InjectionToken<AuthApi>('auth-api', {
  providedIn: 'root',
  factory: () => ({ onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword, signOut }),
});

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(AUTH_API);

  /** undefined while the persisted session is still being restored. */
  readonly user = signal<User | null | undefined>(undefined);
  readonly usingEmulators = this.fb.usingEmulators;

  constructor() {
    this.api.onAuthStateChanged(this.fb.auth, (u) => this.user.set(u));
  }

  signInWithGoogle(): Promise<unknown> {
    return this.api.signInWithPopup(this.fb.auth, new GoogleAuthProvider());
  }

  /** Email and password sign-in, offered only against the emulator. */
  signInForDev(email: string, password: string): Promise<unknown> {
    if (!this.fb.usingEmulators) {
      return Promise.reject(new Error('Dev sign-in is emulator-only.'));
    }
    return this.api.signInWithEmailAndPassword(this.fb.auth, email, password);
  }

  signOut(): Promise<void> {
    return this.api.signOut(this.fb.auth);
  }
}
