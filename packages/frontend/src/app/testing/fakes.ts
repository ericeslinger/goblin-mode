// Spec-support helpers; never imported from production code.
import { signal } from '@angular/core';
import type { User } from 'firebase/auth';
import type { FirebaseHandles } from '../firebase';
import type { NoteRecord } from '../notes/notes.service';

export function fakeFirebase(usingEmulators: boolean): FirebaseHandles {
  return { app: {}, auth: {}, db: {}, usingEmulators } as unknown as FirebaseHandles;
}

/** A stand-in for AuthService with a settable user. */
export class FakeAuthService {
  readonly user = signal<User | null | undefined>(null);
  readonly signedInBefore = signal(false);
  usingEmulators = true;
  signInWithGoogle = vi.fn(() => Promise.resolve());
  signInForDev = vi.fn((_email: string, _password: string) => Promise.resolve());
  signOut = vi.fn(() => Promise.resolve());

  signInAs(email: string): void {
    this.user.set({ email } as User);
  }
}

/** A stand-in for NotesService: an in-memory list and recorded writes. */
export class FakeNotes {
  readonly notes = signal<NoteRecord[]>([]);
  readonly loaded = signal(false);
  get ready(): boolean {
    return this.loaded();
  }
  private n = 0;
  readonly written = new Set<string>();
  save = vi.fn((id: string, _body: string) => void this.written.add(id));
  remove = vi.fn((id: string) => void this.written.delete(id));
  newId = () => `new${++this.n}`;
  find = (id: string) => this.notes().find((x) => x.id === id);
  exists = (id: string) => this.written.has(id) || !!this.find(id);

  signIn(list: NoteRecord[] = []): void {
    this.notes.set(list);
    this.loaded.set(true);
  }
}

export function noteRecord(id: string, body: string): NoteRecord {
  return { id, body, title: body.split('\n')[0], titleSource: 'words', archived: false };
}
