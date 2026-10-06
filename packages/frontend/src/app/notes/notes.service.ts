import { DestroyRef, Injectable, InjectionToken, effect, inject, signal } from '@angular/core';
import { autoId, firstWordsTitle, paths, type TitleSource } from '@goblin/schema';
import {
  type Firestore,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { LocalStore } from '../platform/local-store';
import { RANDOM_BYTES } from '../platform/platform';

/** A note as the app lists and opens it. */
export interface NoteRecord {
  id: string;
  body: string;
  title: string;
  titleSource: TitleSource;
  archived: boolean;
  /** Milliseconds; undefined while a new note's server time is pending. */
  updatedAt?: number;
}

/** The Firestore calls the service makes, as a seam for unit specs. */
export interface NotesApi {
  listen(
    db: Firestore,
    path: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
  set(db: Firestore, path: string, data: Record<string, unknown>, merge: boolean): Promise<void>;
  remove(db: Firestore, path: string): Promise<void>;
  serverTime(): unknown;
}

export const NOTES_API = new InjectionToken<NotesApi>('notes-api', {
  providedIn: 'root',
  factory: () => ({
    listen: (db, path, next, error) =>
      onSnapshot(
        query(collection(db, path), orderBy('updatedAt', 'desc')),
        // Pending server timestamps read as the local estimate, so a note
        // just written offline still sorts to the top.
        (snap) =>
          next(
            snap.docs.map((d) => ({
              id: d.id,
              data: d.data({ serverTimestamps: 'estimate' }),
            })),
          ),
        error,
      ),
    set: (db, path, data, merge) => setDoc(doc(db, path), data, { merge }),
    remove: (db, path) => deleteDoc(doc(db, path)),
    serverTime: () => serverTimestamp(),
  }),
});

function toRecord(id: string, data: Record<string, unknown>): NoteRecord {
  const stamp = data['updatedAt'] as { toMillis?: () => number } | null | undefined;
  return {
    id,
    body: String(data['body'] ?? ''),
    title: String(data['title'] ?? ''),
    titleSource: (data['titleSource'] as TitleSource) ?? 'words',
    archived: data['archived'] === true,
    updatedAt: stamp?.toMillis?.(),
  };
}

/**
 * The signed-in user's notes: a live list (all of them, newest first;
 * one user's notes are small) and the writes. Writes go through the
 * Firestore persistent cache, so they land at once and sync later, and
 * are never awaited by the UI (offline they resolve only on reconnect).
 */
@Injectable({ providedIn: 'root' })
export class NotesService {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(NOTES_API);
  private readonly auth = inject(AuthService);
  private readonly store = inject(LocalStore);
  private readonly random = inject(RANDOM_BYTES);

  readonly notes = signal<NoteRecord[]>([]);
  /** True once the first snapshot for the current user has arrived. */
  readonly loaded = signal(false);

  private uid?: string;
  private stop?: () => void;
  /** Ids written in this session: known to exist even before a snapshot. */
  private readonly written = new Set<string>();

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.notes.set([]);
      this.loaded.set(false);
      this.written.clear();
      if (!uid) return;
      this.stop = this.api.listen(
        this.fb.db,
        paths.notes(uid),
        (docs) => {
          this.notes.set(docs.map((d) => toRecord(d.id, d.data)));
          this.loaded.set(true);
        },
        (err) => console.error('notes listener', err),
      );
    });
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  /** Whether writes can happen yet (the user is known). */
  get ready(): boolean {
    return this.uid !== undefined;
  }

  newId(): string {
    return autoId(this.random);
  }

  find(id: string): NoteRecord | undefined {
    return this.notes().find((n) => n.id === id);
  }

  exists(id: string): boolean {
    return this.written.has(id) || this.find(id) !== undefined;
  }

  /** Writes a note's text: a full document first, then merged updates. */
  save(id: string, body: string): void {
    if (!this.uid) throw new Error('save before sign-in');
    const path = paths.note(this.uid, id);
    const existing = this.find(id);
    const now = this.api.serverTime();
    const title =
      existing?.titleSource === 'user'
        ? {}
        : { title: firstWordsTitle(body), titleSource: 'words' };
    const update = { body, ...title, updatedAt: now, updatedBy: 'user', deviceId: this.deviceId() };
    // A known note gets a merged update, keeping fields this device did
    // not set (Claude's links, tags, a title). A new one gets the full
    // shape the rules require.
    const known = this.exists(id);
    const data = known
      ? update
      : { kind: 'text', links: [], tags: [], archived: false, createdAt: now, ...update };
    this.written.add(id);
    this.api.set(this.fb.db, path, data, known).catch(report);
  }

  remove(id: string): void {
    if (!this.uid) return;
    this.written.delete(id);
    this.notes.update((list) => list.filter((n) => n.id !== id));
    this.api.remove(this.fb.db, paths.note(this.uid, id)).catch(report);
  }

  /** A stable id for this device, recorded on each write (see DESIGN). */
  deviceId(): string {
    let id = this.store.get<string>('goblin.deviceId');
    if (!id) {
      id = this.newId();
      this.store.set('goblin.deviceId', id);
    }
    return id;
  }
}

function report(err: unknown): void {
  console.error('note write failed', err);
}
