import { Injectable, inject, signal } from '@angular/core';
import {
  GoogleAuthProvider,
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { FIREBASE } from './firebase';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly fb = inject(FIREBASE);

  /** undefined while the persisted session is still being restored. */
  readonly user = signal<User | null | undefined>(undefined);
  readonly usingEmulators = this.fb.usingEmulators;

  constructor() {
    onAuthStateChanged(this.fb.auth, (u) => this.user.set(u));
  }

  signInWithGoogle(): Promise<unknown> {
    return signInWithPopup(this.fb.auth, new GoogleAuthProvider());
  }

  /** Email and password sign-in, offered only against the emulator. */
  signInForDev(email: string, password: string): Promise<unknown> {
    if (!this.fb.usingEmulators) {
      return Promise.reject(new Error('Dev sign-in is emulator-only.'));
    }
    return signInWithEmailAndPassword(this.fb.auth, email, password);
  }

  signOut(): Promise<void> {
    return signOut(this.fb.auth);
  }
}
