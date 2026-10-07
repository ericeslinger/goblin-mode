import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { parseNote, wikiLinkTargets } from '@mossgoblin/editor/grammar';
import {
  KEEP_SUFFIX,
  RESTORE_SUFFIX,
  autoId,
  conceptId,
  firstWordsTitle,
  nameIndex,
  normalizeName,
  paths,
  resolveLinks,
  textHash,
  type TitleSource,
} from '@mossgoblin/schema';
import {
  type Firestore,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { LocalStore } from '../platform/local-store';
import { ONLINE, RANDOM_BYTES } from '../platform/platform';

/** Names linked before their concept could be made (needs the server). */
export const PENDING_CONCEPTS_KEY = 'goblin.pendingConcepts';

/** A note as the app lists and opens it. */
export interface NoteRecord {
  id: string;
  body: string;
  title: string;
  titleSource: TitleSource;
  /** 'text', 'sketch', 'concept' or 'template'. */
  kind: string;
  /** A template's mode: 'living' or 'entry' (#36); none reads as entry. */
  templateMode?: string;
  /** The template a note was made from. */
  fromTemplate?: string;
  /** A concept's other names. */
  synonyms?: string[];
  /** A concept's type: 'person', 'project' or 'other'. */
  conceptType?: string;
  /** Ids this note links to (DESIGN.md, Links and concepts). */
  links: string[];
  /** e.g. 'feelings'. */
  tags?: string[];
  archived: boolean;
  /** Milliseconds; undefined while a new note's server time is pending. */
  updatedAt?: number;
  /** When the note was made; milliseconds. */
  createdAt?: number;
  /** When the note was last settled (left after a change); milliseconds. */
  settledAt?: number;
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
  /** Writes `data` only if no document is there; needs the server. */
  createIfAbsent(db: Firestore, path: string, data: Record<string, unknown>): Promise<boolean>;
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
    createIfAbsent: (db, path, data) =>
      runTransaction(db, async (tx) => {
        const ref = doc(db, path);
        if ((await tx.get(ref)).exists()) return false;
        tx.set(ref, data);
        return true;
      }),
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
    kind: typeof data['kind'] === 'string' ? data['kind'] : 'text',
    ...(Array.isArray(data['synonyms']) ? { synonyms: data['synonyms'].map(String) } : {}),
    ...(typeof data['conceptType'] === 'string' ? { conceptType: data['conceptType'] } : {}),
    ...(typeof data['templateMode'] === 'string' ? { templateMode: data['templateMode'] } : {}),
    ...(typeof data['fromTemplate'] === 'string' ? { fromTemplate: data['fromTemplate'] } : {}),
    links: Array.isArray(data['links']) ? data['links'].map(String) : [],
    ...(Array.isArray(data['tags']) && data['tags'].length
      ? { tags: data['tags'].map(String) }
      : {}),
    archived: data['archived'] === true,
    updatedAt: stamp?.toMillis?.(),
    createdAt: (data['createdAt'] as { toMillis?: () => number } | undefined)?.toMillis?.(),
    settledAt: (data['settledAt'] as { toMillis?: () => number } | undefined)?.toMillis?.(),
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
  /** Names to ids, for resolving `[[links]]` (schema, concepts.ts). */
  readonly names = computed(() => nameIndex(this.notes()));
  /** True once the first snapshot for the current user has arrived. */
  readonly loaded = signal(false);

  private uid?: string;
  private stop?: () => void;
  /** Ids written in this session: known to exist even before a snapshot. */
  private readonly written = new Set<string>();
  /** Concepts being made right now, so a second ask waits for the first. */
  private readonly making = new Set<string>();
  private readonly online = inject(ONLINE);

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
          this.makePendingConcepts();
        },
        (err) => console.error('notes listener', err),
      );
    });
    // Concepts waiting for the server are made when it is back.
    const back = () => this.makePendingConcepts();
    globalThis.addEventListener?.('online', back);
    inject(DestroyRef).onDestroy(() => {
      this.stop?.();
      globalThis.removeEventListener?.('online', back);
    });
  }

  /**
   * Whether writes can happen yet: the user is known and their notes
   * have loaded, so `save` can tell a new note from an existing one.
   * Before that, a full write could overwrite a note this device has
   * not seen yet.
   */
  get ready(): boolean {
    return this.uid !== undefined && this.loaded();
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

  /**
   * Writes a note's text: a full document first, then merged updates.
   * A restore writes as its own writer (`RESTORE_SUFFIX`), so noteHistory
   * keeps the text it replaces.
   */
  save(
    id: string,
    body: string,
    {
      restore = false,
      keep = false,
      base,
    }: { restore?: boolean; keep?: boolean; base?: string } = {},
  ): void {
    if (!this.uid) throw new Error('save before sign-in');
    const path = paths.note(this.uid, id);
    const existing = this.find(id);
    const now = this.api.serverTime();
    // Eric's own title stays, and so does Claude's: noteTitle replaces it
    // the next time the note is settled. A restore brings back other
    // text, so Claude's title for the newer text goes with it.
    const keepTitle =
      existing?.titleSource === 'user' || (existing?.titleSource === 'llm' && !restore);
    const title = keepTitle ? {} : { title: firstWordsTitle(body), titleSource: 'words' };
    // A restore, or a keep (Done shopping), writes as its own writer, so
    // noteHistory keeps the text it replaces.
    const deviceId = this.deviceId() + (restore ? RESTORE_SUFFIX : keep ? KEEP_SUFFIX : '');
    const links = resolveLinks(wikiLinkTargets(parseNote(body)), this.names());
    // What this text was written over, so a write over a newer text
    // (Claude's, another device's) is merged on the server (#37).
    const baseHash = base === undefined ? '' : textHash(base);
    const update = { body, ...title, links, baseHash, updatedAt: now, updatedBy: 'user', deviceId };
    // A known note gets a merged update, keeping fields this device did
    // not set (Claude's links, tags, a title). A new one gets the full
    // shape the rules require.
    const known = this.exists(id);
    const data = known
      ? update
      : { kind: 'text', tags: [], archived: false, createdAt: now, ...update };
    this.written.add(id);
    this.api.set(this.fb.db, path, data, known).catch(report);
  }

  /**
   * Writes a new note in its full shape at once, for a note that must
   * exist before anyone types in it: a template, or a note made from one
   * (#38). The id is fresh, so nothing can be overwritten.
   */
  create(
    id: string,
    body: string,
    fields: { kind?: 'text' | 'template'; templateMode?: string; fromTemplate?: string } = {},
  ): void {
    if (!this.uid) throw new Error('create before sign-in');
    const now = this.api.serverTime();
    const data = {
      kind: 'text',
      body,
      title: firstWordsTitle(body),
      titleSource: 'words',
      links: resolveLinks(wikiLinkTargets(parseNote(body)), this.names()),
      tags: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'user',
      deviceId: this.deviceId(),
      ...fields,
    };
    this.written.add(id);
    this.api.set(this.fb.db, paths.note(this.uid, id), data, false).catch(report);
  }

  /** Living or entry, for a template. */
  setTemplateMode(id: string, mode: 'living' | 'entry'): void {
    if (!this.uid || this.find(id)?.kind !== 'template') return;
    const update = {
      templateMode: mode,
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.api.set(this.fb.db, paths.note(this.uid, id), update, true).catch(report);
  }

  /**
   * Makes the concepts a body links to by names nothing answers to yet
   * (stub concepts, #29): kind 'concept', the name as written, no text.
   */
  plantConcepts(body: string): void {
    const names = this.names();
    for (const target of wikiLinkTargets(parseNote(body))) {
      if (names.has(normalizeName(target))) continue;
      this.createConcept(target);
    }
  }

  /**
   * Asks for a stub concept for `name` and returns its id. The stub is
   * made in a transaction that writes only if the concept does not
   * exist, so it can never replace a concept another device or Claude
   * made (review on #65). A transaction needs the server: until the
   * notes have loaded and the device is online, the name waits on the
   * device and is made then.
   */
  createConcept(name: string): string {
    const id = conceptId(name);
    if (this.exists(id)) return id;
    const pending = this.store.get<string[]>(PENDING_CONCEPTS_KEY) ?? [];
    if (!pending.some((n) => conceptId(n) === id)) {
      this.store.set(PENDING_CONCEPTS_KEY, [...pending, name.trim()]);
    }
    this.makePendingConcepts();
    return id;
  }

  /** Makes the concepts waiting on this device, where it can. */
  makePendingConcepts(): void {
    const uid = this.uid;
    if (!this.ready || !uid || !this.online()) return;
    for (const name of this.store.get<string[]>(PENDING_CONCEPTS_KEY) ?? []) {
      const id = conceptId(name);
      if (this.exists(id)) {
        this.donePending(id);
        continue;
      }
      if (this.making.has(id)) continue;
      this.making.add(id);
      const now = this.api.serverTime();
      const stub = {
        kind: 'concept',
        body: '',
        title: name,
        // The name is Eric's: a settle never retitles a concept.
        titleSource: 'user',
        conceptType: 'other',
        synonyms: [],
        links: [],
        tags: [],
        archived: false,
        createdAt: now,
        updatedAt: now,
        updatedBy: 'user',
        deviceId: this.deviceId(),
      };
      this.api
        .createIfAbsent(this.fb.db, paths.note(uid, id), stub)
        .then(() => this.donePending(id))
        // Offline after all, or refused: it stays waiting for next time.
        .catch((err) => console.warn('concept not made yet', err))
        .finally(() => this.making.delete(id));
    }
  }

  private donePending(id: string): void {
    const pending = this.store.get<string[]>(PENDING_CONCEPTS_KEY) ?? [];
    const rest = pending.filter((n) => conceptId(n) !== id);
    if (rest.length) this.store.set(PENDING_CONCEPTS_KEY, rest);
    else this.store.remove(PENDING_CONCEPTS_KEY);
  }

  /**
   * Changes a concept's name, type or other names. A new name keeps the
   * id (derived from the first name) and adds the old one as a synonym,
   * so links written with it still land (#30). A name another note
   * already answers to is refused, so a concept can never take over
   * another's links (review on #66); the refused names are returned.
   * The exception is an empty stub concept (no text, no other names),
   * made by linking the name before it was known to mean this concept:
   * it is folded in, archived with `mergedInto`, never deleted.
   */
  updateConcept(
    id: string,
    change: { title?: string; conceptType?: string; synonyms?: string[] },
  ): string[] {
    const concept = this.find(id);
    if (!this.uid || concept?.kind !== 'concept') return [];
    const names = this.names();
    const refused: string[] = [];
    const folded = new Set<string>();
    const free = (name: string) => {
      const owner = names.get(normalizeName(name));
      if (owner === undefined || owner === id) return true;
      const stub = this.find(owner);
      if (stub?.kind === 'concept' && !stub.body.trim() && !stub.synonyms?.length) {
        folded.add(owner);
        return true;
      }
      refused.push(name.trim());
      return false;
    };
    const update: Record<string, unknown> = {};
    let synonyms = change.synonyms ?? concept.synonyms ?? [];
    const title = change.title?.trim();
    if (title && title !== concept.title && free(title)) {
      update['title'] = title;
      update['titleSource'] = 'user';
      if (!synonyms.some((s) => normalizeName(s) === normalizeName(concept.title))) {
        synonyms = [...synonyms, concept.title];
      }
    }
    const named = (update['title'] as string | undefined) ?? concept.title;
    const clean = [...new Map(synonyms.map((s) => [normalizeName(s), s.trim()])).values()].filter(
      (s) => s && normalizeName(s) !== normalizeName(named) && free(s),
    );
    if (change.synonyms || update['title']) update['synonyms'] = clean;
    if (change.conceptType) update['conceptType'] = change.conceptType;
    if (Object.keys(update).length === 0) return refused;
    const path = paths.note(this.uid, id);
    const stamp = {
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.api.set(this.fb.db, path, { ...update, ...stamp }, true).catch(report);
    for (const stub of folded) {
      const merged = { archived: true, mergedInto: id, ...stamp };
      this.api.set(this.fb.db, paths.note(this.uid, stub), merged, true).catch(report);
    }
    return refused;
  }

  /**
   * Marks a note settled (Eric left it), which asks noteTitle for a
   * Claude title. `edited`: the caller saw it typed in and saved, with
   * text. Otherwise only a note with text written since its last settle
   * is settled, so reading an old note never calls Claude. The body and
   * updatedAt are left alone.
   */
  settle(id: string, { edited = false }: { edited?: boolean } = {}): void {
    if (!this.uid) return;
    // A template keeps the name its first line gives it.
    if (this.find(id)?.kind === 'template') return;
    if (!edited) {
      const note = this.find(id);
      if (!note?.body.trim()) return;
      const changedSince =
        note.settledAt === undefined ||
        (note.updatedAt !== undefined && note.updatedAt > note.settledAt);
      if (!changedSince) return;
    }
    this.api
      .set(this.fb.db, paths.note(this.uid, id), { settledAt: this.api.serverTime() }, true)
      .catch(report);
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
