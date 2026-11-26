import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { parseNote, wikiLinkTargets } from '@mossgoblin/editor/grammar';
import {
  CONTEXT_ID,
  KEEP_SUFFIX,
  FISH_BODY,
  PANTRY_BODY,
  PANTRY_ID,
  PANTRY_TITLE,
  FISH_ID,
  FISH_NAME,
  type KitchenConfig,
  addRecipeNote,
  importPlaceholder,
  isImportPlaceholder,
  madeHistory,
  planBody,
  planId,
  planTitle,
  recipeSkeleton,
  untouchedRecipe,
  ProjectKind,
  ProjectStatus,
  RESTORE_SUFFIX,
  autoId,
  canParent,
  conceptId,
  firstWordsTitle,
  moodTargets,
  nameIndex,
  normalizeName,
  paths,
  resolveLinks,
  type TitleSource,
  agentOf,
  SEND_ASK_MAX,
  NoteMode,
  takesInstructions,
  type DataKey,
  type SealedField,
  type SealedRecordCollection,
  type SealedRecordField,
  SEALED_FIELDS,
  SealError,
  aadFor,
  recordAadFor,
  fieldValue,
  noteTextHash,
  isSealed,
  isSealedValue,
  openText,
  sealText,
  withFieldValue,
  isShareId,
  newShareId,
} from '@mossgoblin/schema';
import {
  type Firestore,
  collection,
  deleteDoc,
  deleteField,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  waitForPendingWrites,
  writeBatch,
} from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { LocalStore } from '../platform/local-store';
import { NOW, ONLINE, RANDOM_BYTES } from '../platform/platform';
import { NoteKeyService } from './note-key.service';
import { type PendingWrites, isPendingWrite, lost, nextPending } from './pending-writes';
import { KeyWaitNotice } from './key-wait-notice';
import { shareCopyOf, shareRefusal } from '../public-copy/share-copy';

/** Names linked before their concept could be made (needs the server). */
export const PENDING_CONCEPTS_KEY = 'goblin.pendingConcepts';
/** The ids among them to make as moods (#40). */
export const PENDING_MOODS_KEY = 'goblin.pendingMoods';
/** Items waiting to be made, by id: the project they go in, and their stage. */
export const PENDING_ITEMS_KEY = 'goblin.pendingItems';
type PendingItems = Record<string, { parent: string; stage?: string }>;
/**
 * Instructions for Claude written or typed but not yet acknowledged
 * (#198, #200), by note id (a template's, or since #231 any note that
 * takes instructions), kept until the server has them
 * (`pending-writes.ts`; null base: no field).
 */
export const PENDING_INSTRUCTIONS_KEY = 'goblin.pendingInstructions';
/**
 * Note text saved but not yet acknowledged (#200), by note id, kept the
 * same way (null base: a new note), with the writer a restore or a keep
 * wrote as.
 */
export const PENDING_SAVES_KEY = 'goblin.pendingSaves';
/**
 * A recipe's or a concept's name typed but not yet acknowledged (#205),
 * by note id, kept the same way. One store serves both: a note is one
 * kind or the other, and the replay renames it through its own kind's
 * path, a concept's with its synonyms and stub folding.
 */
export const PENDING_NAMES_KEY = 'goblin.pendingNames';

/**
 * What a recipe made from a share says until the shared words are read
 * (2026-11-14): shown as "Could not import from <site>: ..." only if the
 * app never got to hand them over.
 */
export const SHARED_IMPORT_WAITING = 'it came from a share, and what was shared is not read yet';
type PendingSaves = Record<
  string,
  PendingWrites[string] & {
    as?: 'restore' | 'keep';
    /**
     * Held for the key (2026-11-15): this device has no key yet, so the
     * words were kept here and not written, since note text is always
     * written sealed. `base` is the text they were typed over, as the
     * server last had it, kept from the first save held, for the
     * write's `baseHash` once the key is here. (Until the always sealed
     * change of the same day a save was also held while this device had
     * not heard the gardener's switch; such entries are replayed the
     * same way.)
     */
    held?: { base?: string };
  }
>;

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
  /**
   * Instructions for Claude: a template's, once moved out of its body
   * (#111), or since #231 any note's that takes them.
   */
  instructions?: string;
  /** How the note takes new material (#231): 'list', 'log' or 'synthesis'. */
  mode?: NoteMode;
  /** A recipe's source and servings (#127). */
  source?: { url?: string; attachmentId?: string; text?: string; feedItemId?: string };
  servings?: number;
  /** An import from `source.url` the app asked for (#128), and why it failed. */
  importState?: 'requested' | 'working' | 'done' | 'failed';
  importError?: string;
  /** A meal plan's first day, YYYY-MM-DD (#129). */
  periodStart?: string;
  /**
   * Sent to an assistant (#143): waiting, with Eric's ask and when, or
   * done, with the assistant's one line on what it did.
   */
  sendState?: 'queued' | 'done';
  sendAsk?: string;
  sentAt?: number;
  sendOutcome?: string;
  /** The run doing it now (#144 step 3), if Eric asked for one. */
  sendRun?: string;
  /** Sent by the server when it first settled, not by Eric (#214). */
  sentOnArrival?: boolean;
  /** Leave this note alone (#229): never sent on arrival. */
  gardenHold?: boolean;
  /** A concept's other names. */
  synonyms?: string[];
  /** A concept's type: 'person', 'project', 'mood' or 'other'. */
  conceptType?: string;
  /** A project's parent project (#41). */
  parent?: string;
  /** A project's kind: 'build' or 'content'. */
  projectKind?: ProjectKind;
  /** A project's status, e.g. 'active' or 'waiting'. */
  projectStatus?: ProjectStatus;
  /** A project's stages and item tags; a sub-project's stage (2026-10-17). */
  stages?: string[];
  itemTags?: string[];
  stage?: string;
  /** Ids this note links to (DESIGN.md, Links and concepts). */
  links: string[];
  /** e.g. 'feelings'. */
  tags?: string[];
  archived: boolean;
  /** In Trash since (#217); milliseconds, on the deleting device's clock. */
  deletedAt?: number;
  /** Milliseconds; undefined while a new note's server time is pending. */
  updatedAt?: number;
  /** When the note was made; milliseconds. */
  createdAt?: number;
  /** When the note was last settled (left after a change); milliseconds. */
  settledAt?: number;
  /** Who wrote it last: a device id (with a restore or keep suffix), or 'merge'. */
  deviceId?: string;
  /** Whether that was Eric or an assistant, and which one (#142). */
  updatedBy?: 'user' | 'claude';
  agent?: string;
  /**
   * The hash of the text the last body write replaced, when known
   * (#241): plain, or keyed (`k1.`) for a sealed note (2026-11-14).
   */
  baseHash?: string;
  /**
   * Sealed, and this device cannot open it yet (note encryption step 3a):
   * no key here, or not this note's key. `body` is then '' and `title`
   * is `SEALED_TITLE`, never the sealed text, and nothing writes to it.
   */
  locked?: true;
  /**
   * The id of the note's public copy, `shares/{shareId}`, while it is
   * shared (2026-11-26): the link's secret part.
   */
  shareId?: string;
}

/**
 * Public-copy writes waiting for the server, kept on the device
 * (2026-11-26). Its own key: `goblin.pendingShares` is the share
 * sheet's (share-store.ts), and writing there emptied the shares
 * waiting to be filed (a full run caught it).
 */
export const PUBLIC_COPY_WRITES_KEY = 'goblin.publicCopyWrites';
/**
 * A public-copy write: what it does, to which note, for which account.
 * Waiting until the server has it; `failed` once the server refused it
 * (review of #343: a refused batch is never read as done).
 */
export interface PublicCopyWrite {
  uid: string;
  noteId: string;
  title: string;
  op: 'share' | 'update' | 'stop';
  at: number;
  failed?: true;
}

/** Whether a stored value is a public-copy write of today's shape. */
function isCopyWrite(v: unknown): v is PublicCopyWrite {
  const w = v as Partial<PublicCopyWrite> | null;
  return (
    !!w &&
    typeof w.uid === 'string' &&
    typeof w.noteId === 'string' &&
    typeof w.at === 'number' &&
    (w.op === 'share' || w.op === 'update' || w.op === 'stop')
  );
}

/** What a note this device cannot open shows in place of its title. */
export const SEALED_TITLE = 'Sealed note';

/** A note document as a snapshot gives it. */
export interface NoteDoc {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Opens one sealed field of note `id`: its text, or undefined when this
 * device cannot open it. Only called with sealed values.
 */
export type FieldOpener = (id: string, field: SealedField, value: string) => string | undefined;

/** The opener with no key: every sealed value stays shut. */
const NO_KEY: FieldOpener = () => undefined;

/**
 * The text of a sealed `value` in field `field` of note `noteId`, or
 * undefined when `key` is missing or does not open it. A history
 * version opens with its note's own id (DESIGN.md, Note encryption).
 */
export function openField(
  key: DataKey | undefined,
  uid: string,
  noteId: string,
  field: SealedField,
  value: string,
): string | undefined {
  if (!key) return undefined;
  try {
    return openText(key, aadFor(uid, noteId, field), value);
  } catch (err) {
    if (err instanceof SealError) return undefined;
    throw err;
  }
}

/**
 * The text of a sealed `value` in field `field` of record `docId` in
 * `collection` (a suggestion or a run, step 3e, 2026-11-13), or
 * undefined when `key` is missing or does not open it. Bound to the
 * record, never to a note (`recordAadFor`), so a value moved from a
 * note or another record does not open.
 */
export function openRecordField<C extends SealedRecordCollection>(
  key: DataKey | undefined,
  uid: string,
  collection: C,
  docId: string,
  field: SealedRecordField<C>,
  value: string,
): string | undefined {
  if (!key) return undefined;
  try {
    return openText(key, recordAadFor(uid, collection, docId, field), value);
  } catch (err) {
    if (err instanceof SealError) return undefined;
    throw err;
  }
}

/**
 * Opened note text (step 3a), so a new snapshot opens only what changed:
 * keyed by note, field and the sealed value itself, so a changed value
 * is a new entry and never reads as the old text. Each pass keeps only
 * the entries that pass used, so the cache holds at most the sealed
 * fields of the latest snapshot and cannot grow without limit. A failed
 * open is kept too, so a wrong key costs one try per value, not one per
 * snapshot. A different key or gardener drops it all.
 */
export class OpenedTexts {
  private key?: DataKey;
  private uid?: string;
  private kept = new Map<string, string | null>();
  /** How many values were actually opened (tried), for specs. */
  tries = 0;

  /**
   * A pass over one snapshot: the opener for it. `key` is read only on
   * the first sealed value, so with only plain notes nothing depends on
   * the key and its arrival recomputes nothing.
   */
  pass(key: () => DataKey | undefined, uid: string): FieldOpener {
    const prev = this.kept;
    const next = new Map<string, string | null>();
    let started = false;
    let held: DataKey | undefined;
    this.kept = next;
    return (id, field, value) => {
      if (!started) {
        started = true;
        held = key();
        if (held !== this.key || uid !== this.uid) {
          this.key = held;
          this.uid = uid;
          prev.clear();
        }
      }
      if (!held) return undefined;
      const at = `${id}\u0000${field}\u0000${value}`;
      let text = next.has(at) ? next.get(at) : prev.get(at);
      if (text === undefined) {
        this.tries++;
        text = openField(held, uid, id, field, value) ?? null;
      }
      next.set(at, text);
      return text ?? undefined;
    };
  }

  /** Forgets everything opened: signed out. */
  clear(): void {
    this.kept = new Map();
    this.key = this.uid = undefined;
  }
}

/**
 * Refused: a write to a note this device cannot open (step 3a). Its
 * record holds placeholders, so anything written from it would be
 * written over text this device has not seen.
 */
export class LockedNoteError extends Error {
  override readonly name: string = 'LockedNoteError';
}

/**
 * `api` with every write to a locked note refused, at the one seam all
 * of NotesService's writes share: `locked` says whether a path is a
 * locked note's document.
 */
function refusingLocked(api: NotesApi, locked: (path: string) => boolean): NotesApi {
  const refuse = () =>
    Promise.reject(
      new LockedNoteError('not written: the note is sealed and its key is not on this device'),
    );
  return {
    ...api,
    set: (db, path, data, merge) => (locked(path) ? refuse() : api.set(db, path, data, merge)),
    createIfAbsent: (db, path, data) =>
      locked(path) ? refuse() : api.createIfAbsent(db, path, data),
    remove: (db, path) => (locked(path) ? refuse() : api.remove(db, path)),
    commit: (db, writes) =>
      writes.some((w) => locked(w.path)) ? refuse() : api.commit(db, writes),
  };
}

/**
 * Refused: this device has no key yet (2026-11-15), and note text is
 * always written sealed, so a write holding it cannot go out. A kept
 * write waits for the key, as for a locked note.
 */
export class KeyWaitError extends LockedNoteError {
  override readonly name: string = 'KeyWaitError';
}

/**
 * `api` with every write to a note document passed through `seal`
 * first (2026-11-15): every sealed field in it is sealed, or the write
 * is refused. One seam for every NotesService writer, as
 * `refusingLocked` is. It is synchronous, so a write with the key goes
 * into the persistent cache at once, as it always did.
 */
function sealingNotes(
  api: NotesApi,
  seal: (path: string, data: Record<string, unknown>, merge: boolean) => Record<string, unknown>,
): NotesApi {
  const sealed = (path: string, data: Record<string, unknown>, merge: boolean) => {
    try {
      return { data: seal(path, data, merge) };
    } catch (err) {
      return { err };
    }
  };
  return {
    ...api,
    set: (db, path, data, merge) => {
      const out = sealed(path, data, merge);
      return 'err' in out ? Promise.reject(out.err) : api.set(db, path, out.data, merge);
    },
    createIfAbsent: (db, path, data) => {
      const out = sealed(path, data, false);
      return 'err' in out ? Promise.reject(out.err) : api.createIfAbsent(db, path, out.data);
    },
    commit: (db, writes) => {
      const out: BatchWrite[] = [];
      for (const w of writes) {
        if (!w.data) {
          out.push(w);
          continue;
        }
        const one = sealed(w.path, w.data, w.merge ?? false);
        if ('err' in one) return Promise.reject(one.err);
        out.push({ ...w, data: one.data });
      }
      return api.commit(db, out);
    },
  };
}

/** One write of a batch: `data` set (merged or whole) at `path`, or the document deleted. */
export interface BatchWrite {
  path: string;
  /** Without it, the document is deleted. */
  data?: Record<string, unknown>;
  merge?: boolean;
}

/** The Firestore calls the service makes, as a seam for unit specs. */
export interface NotesApi {
  listen(
    db: Firestore,
    path: string,
    /** `fromCache`: the persisted cache's view, which may be stale (#200). */
    next: (docs: { id: string; data: Record<string, unknown> }[], fromCache: boolean) => void,
    error: (err: unknown) => void,
  ): () => void;
  set(db: Firestore, path: string, data: Record<string, unknown>, merge: boolean): Promise<void>;
  /** Writes `data` only if no document is there; needs the server. */
  createIfAbsent(db: Firestore, path: string, data: Record<string, unknown>): Promise<boolean>;
  remove(db: Firestore, path: string): Promise<void>;
  /**
   * Several writes as one, all or none, through the persistent cache
   * like any write: it lands at once and resolves when the server has
   * it (2026-11-26, a share and its note together).
   */
  commit(db: Firestore, writes: BatchWrite[]): Promise<void>;
  /** Resolves once every write made so far has reached the server. */
  synced(db: Firestore): Promise<void>;
  serverTime(): unknown;
  /** A Timestamp at `ms`, for a stamp taken from the device's clock. */
  timestamp(ms: number): unknown;
  /** Takes a field out in a merged write. */
  removeField(): unknown;
}

export const NOTES_API = new InjectionToken<NotesApi>('notes-api', {
  providedIn: 'root',
  factory: () => ({
    listen: (db, path, next, error) => {
      // With metadata changes, so the first snapshot from the server is
      // seen even when no document changed (#200); one that changes
      // nothing else (a write acknowledged) is not passed on.
      let fromCache: boolean | undefined;
      return onSnapshot(
        query(collection(db, path), orderBy('updatedAt', 'desc')),
        { includeMetadataChanges: true },
        (snap) => {
          const changed = snap.metadata.fromCache !== fromCache;
          if (!changed && snap.docChanges().length === 0) return;
          fromCache = snap.metadata.fromCache;
          // Pending server timestamps read as the local estimate, so a
          // note just written offline still sorts to the top.
          next(
            snap.docs.map((d) => ({
              id: d.id,
              data: d.data({ serverTimestamps: 'estimate' }),
            })),
            fromCache,
          );
        },
        error,
      );
    },
    set: (db, path, data, merge) => setDoc(doc(db, path), data, { merge }),
    createIfAbsent: (db, path, data) =>
      runTransaction(db, async (tx) => {
        const ref = doc(db, path);
        if ((await tx.get(ref)).exists()) return false;
        tx.set(ref, data);
        return true;
      }),
    remove: (db, path) => deleteDoc(doc(db, path)),
    commit: (db, writes) => {
      const batch = writeBatch(db);
      for (const w of writes) {
        if (w.data) batch.set(doc(db, w.path), w.data, { merge: w.merge ?? false });
        else batch.delete(doc(db, w.path));
      }
      return batch.commit();
    },
    synced: (db) => waitForPendingWrites(db),
    serverTime: () => serverTimestamp(),
    timestamp: (ms) => Timestamp.fromMillis(ms),
    removeField: () => deleteField(),
  }),
});

/** A recipe's source as stored, keeping only the string fields it may have. */
function recipeSource(value: unknown): NoteRecord['source'] {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const out = Object.fromEntries(
    (['url', 'attachmentId', 'text'] as const)
      .filter((k) => typeof v[k] === 'string' && v[k])
      .map((k) => [k, v[k] as string]),
  );
  return Object.keys(out).length ? out : undefined;
}

/**
 * `data` with its other sealed fields (every one but body and title,
 * step 3d, 2026-11-13) opened with `open`, a list element by element; a
 * field that will not open is left out. Plain values pass through, and
 * with none sealed `data` comes back as it is.
 */
function openOthers(
  id: string,
  data: Record<string, unknown>,
  open: FieldOpener,
): { data: Record<string, unknown>; unopened: boolean } {
  let out = data;
  let unopened = false;
  for (const field of SEALED_FIELDS) {
    if (field === 'body' || field === 'title') continue;
    const value = fieldValue(data, field);
    if (!isSealedValue(value)) continue;
    const one = (v: string) => (isSealed(v) ? open(id, field, v) : v);
    const text = Array.isArray(value) ? value.map(one) : one(value as string);
    const shut = Array.isArray(text) ? text.some((t) => t === undefined) : text === undefined;
    if (shut) unopened = true;
    out = withFieldValue(out, field, shut ? undefined : (text as string | string[]));
  }
  return { data: out, unopened };
}

/**
 * A note as the app reads it, from its stored document: the one place
 * the app decodes a note (step 3a). A sealed `body` or `title` is opened
 * with `open`, and since step 3d (2026-11-13) every other sealed field
 * too (the other names, instructions, the Send to ask and outcome, an
 * import error, a recipe's source text); plain text passes through as
 * it always has. If any will not open the note is `locked`: its body
 * and title the placeholders, and a field that did not open left out.
 */
export function toRecord(
  id: string,
  raw: Record<string, unknown>,
  open: FieldOpener = NO_KEY,
): NoteRecord {
  const stamp = raw['updatedAt'] as { toMillis?: () => number } | null | undefined;
  const stored = { body: String(raw['body'] ?? ''), title: String(raw['title'] ?? '') };
  const body = isSealed(stored.body) ? open(id, 'body', stored.body) : stored.body;
  const title = isSealed(stored.title) ? open(id, 'title', stored.title) : stored.title;
  const { data, unopened } = openOthers(id, raw, open);
  const locked = body === undefined || title === undefined || unopened;
  return {
    id,
    body: locked ? '' : body,
    title: locked ? SEALED_TITLE : title,
    ...(locked ? { locked: true as const } : {}),
    titleSource: (data['titleSource'] as TitleSource) ?? 'words',
    kind: typeof data['kind'] === 'string' ? data['kind'] : 'text',
    ...(Array.isArray(data['synonyms']) ? { synonyms: data['synonyms'].map(String) } : {}),
    ...(typeof data['conceptType'] === 'string' ? { conceptType: data['conceptType'] } : {}),
    ...(typeof data['parent'] === 'string' ? { parent: data['parent'] } : {}),
    ...(ProjectKind.safeParse(data['projectKind']).success
      ? { projectKind: data['projectKind'] as ProjectKind }
      : {}),
    ...(ProjectStatus.safeParse(data['projectStatus']).success
      ? { projectStatus: data['projectStatus'] as ProjectStatus }
      : {}),
    ...(Array.isArray(data['stages']) ? { stages: data['stages'].map(String) } : {}),
    ...(Array.isArray(data['itemTags']) ? { itemTags: data['itemTags'].map(String) } : {}),
    ...(typeof data['stage'] === 'string' ? { stage: data['stage'] } : {}),
    ...(typeof data['templateMode'] === 'string' ? { templateMode: data['templateMode'] } : {}),
    ...(typeof data['fromTemplate'] === 'string' ? { fromTemplate: data['fromTemplate'] } : {}),
    ...(typeof data['instructions'] === 'string' ? { instructions: data['instructions'] } : {}),
    ...(NoteMode.safeParse(data['mode']).success ? { mode: data['mode'] as NoteMode } : {}),
    ...(recipeSource(data['source']) ? { source: recipeSource(data['source']) } : {}),
    ...(typeof data['servings'] === 'number' ? { servings: data['servings'] } : {}),
    ...(['requested', 'working', 'done', 'failed'].includes(data['importState'] as string)
      ? { importState: data['importState'] as NoteRecord['importState'] }
      : {}),
    ...(typeof data['importError'] === 'string' ? { importError: data['importError'] } : {}),
    ...(typeof data['periodStart'] === 'string' ? { periodStart: data['periodStart'] } : {}),
    ...(data['sendState'] === 'queued' || data['sendState'] === 'done'
      ? { sendState: data['sendState'] }
      : {}),
    ...(typeof data['sendAsk'] === 'string' && data['sendAsk'] ? { sendAsk: data['sendAsk'] } : {}),
    ...(typeof (data['sentAt'] as { toMillis?: unknown } | undefined)?.toMillis === 'function'
      ? { sentAt: (data['sentAt'] as { toMillis: () => number }).toMillis() }
      : {}),
    ...(typeof data['sendOutcome'] === 'string' ? { sendOutcome: data['sendOutcome'] } : {}),
    ...(typeof data['sendRun'] === 'string' ? { sendRun: data['sendRun'] } : {}),
    ...(data['sentOnArrival'] === true ? { sentOnArrival: true } : {}),
    ...(data['gardenHold'] === true ? { gardenHold: true } : {}),
    ...(data['updatedBy'] === 'claude' || data['updatedBy'] === 'user'
      ? { updatedBy: data['updatedBy'] }
      : {}),
    ...(data['updatedBy'] === 'claude' ? { agent: agentOf(data) } : {}),
    links: Array.isArray(data['links']) ? data['links'].map(String) : [],
    ...(Array.isArray(data['tags']) && data['tags'].length
      ? { tags: data['tags'].map(String) }
      : {}),
    archived: data['archived'] === true,
    ...(typeof (data['deletedAt'] as { toMillis?: unknown } | undefined)?.toMillis === 'function'
      ? { deletedAt: (data['deletedAt'] as { toMillis: () => number }).toMillis() }
      : {}),
    updatedAt: stamp?.toMillis?.(),
    createdAt: (data['createdAt'] as { toMillis?: () => number } | undefined)?.toMillis?.(),
    settledAt: (data['settledAt'] as { toMillis?: () => number } | undefined)?.toMillis?.(),
    ...(typeof data['deviceId'] === 'string' ? { deviceId: data['deviceId'] } : {}),
    ...(typeof data['baseHash'] === 'string' && data['baseHash']
      ? { baseHash: data['baseHash'] }
      : {}),
    ...(isShareId(data['shareId']) ? { shareId: data['shareId'] } : {}),
  };
}

/**
 * The signed-in user's notes: a live list (all of them but those in
 * Trash, newest first; one user's notes are small) and the writes. Writes go through the
 * Firestore persistent cache, so they land at once and sync later, and
 * are never awaited by the UI (offline they resolve only on reconnect).
 */
@Injectable({ providedIn: 'root' })
export class NotesService {
  private readonly fb = inject(FIREBASE);
  /**
   * Every write goes through here: none reaches a locked note (step 3a),
   * and every note text in one is sealed, or the write refused
   * (2026-11-15).
   */
  private readonly api = refusingLocked(
    sealingNotes(inject(NOTES_API), (path, data, merge) => this.sealWrite(path, data, merge)),
    (path) => this.lockedAt(path),
  );
  private readonly auth = inject(AuthService);
  private readonly keys = inject(NoteKeyService);
  /**
   * Notes whose words are held on this device for the key (2026-11-15):
   * the key is not here yet, so their saves are kept
   * (`goblin.pendingSaves`, marked `held`) and not written.
   */
  private readonly heldIds = signal<ReadonlySet<string>>(new Set());
  /** Something waits on this device for the key. */
  readonly waitingForKey = computed(() => this.heldIds().size > 0);
  /**
   * The garden's note key service is not set up (`/api/note-key`
   * answered the Worker's own 503, NoteKeyService.unconfigured): a fork
   * whose owner has not set the master (README, Run your own). Said in
   * the waiting line, so it is not mistaken for a missing connection.
   */
  readonly keyServiceMissing = computed(() => this.keys.unconfigured());
  /** A kept write was refused for want of the key; tried again when it comes. */
  private keyWaited = false;
  /** Says on the page that a write was refused for want of the key (2026-11-15). */
  private readonly notice = inject(KeyWaitNotice);
  /**
   * A kept write (a rename, Instructions for Claude) is going out: one
   * refused for want of the key waits and is written later, so the page
   * is not told it was not done. Set only while such a write is made,
   * synchronously, as the seam seals it.
   */
  private keptWrite = false;
  private readonly store = inject(LocalStore);
  private readonly random = inject(RANDOM_BYTES);

  /**
   * The documents as the latest snapshot gave them, and whose (step 3a).
   * Records are derived from these and the gardener's key, so a key that
   * arrives after the snapshot, or changes, opens the notes then.
   */
  private readonly snapshot = signal<{ uid: string; docs: NoteDoc[] } | undefined>(undefined);
  private readonly opened = new OpenedTexts();
  private readonly records = computed(() => {
    const snap = this.snapshot();
    if (!snap) {
      this.opened.clear();
      return [];
    }
    const open = this.opened.pass(() => this.keys.key(), snap.uid);
    return snap.docs.map((d) => toRecord(d.id, d.data, open));
  });
  readonly notes = computed(() => this.records().filter((n) => n.deletedAt === undefined));
  /**
   * Notes in Trash (#217), the last deleted first. Kept apart from
   * `notes`, so every list, lens, count and link leaves them out, as
   * for a note that is not there.
   */
  readonly trash = computed(() =>
    this.records()
      .filter((n) => n.deletedAt !== undefined)
      .sort((a, b) => b.deletedAt! - a.deletedAt!),
  );
  /** The ids of the notes this device cannot open yet, one per line. */
  private readonly lockedIds = computed(() =>
    this.records()
      .filter((n) => n.locked)
      .map((n) => n.id)
      .join('\n'),
  );
  /**
   * Names to ids, for resolving `[[links]]` (schema, concepts.ts). A
   * locked note answers to its other names, never to the placeholder.
   */
  readonly names = computed(() =>
    nameIndex(this.notes().map((n) => (n.locked ? { ...n, title: '' } : n))),
  );
  /** When each recipe was made, by normalized name, from the meal plans (#129). */
  readonly made = computed(() =>
    madeHistory(this.notes().filter((n) => n.kind === 'mealplan' && !n.archived)),
  );
  /** True once the first snapshot for the current user has arrived. */
  readonly loaded = signal(false);

  private uid?: string;
  private stop?: () => void;
  /** Ids written in this session: known to exist even before a snapshot. */
  private readonly written = new Set<string>();
  /** Whether this sign-in's kept writes were checked against the server (#200). */
  private replayed = false;
  /**
   * The kept writes as this sign-in found them, by storage key: only
   * these are replayed. Words typed again since look after themselves.
   */
  private atLoad: Record<string, PendingWrites> = {};
  /** Concepts being made right now, so a second ask waits for the first. */
  private readonly making = new Set<string>();
  private readonly online = inject(ONLINE);
  private readonly now = inject(NOW);

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.snapshot.set(undefined);
      // Text opened for the last gardener goes with them.
      this.opened.clear();
      this.loaded.set(false);
      this.written.clear();
      this.replayed = false;
      this.keyWaited = false;
      this.heldIds.set(uid ? this.heldInStore(uid) : new Set());
      this.atLoad = Object.fromEntries(
        [PENDING_SAVES_KEY, PENDING_INSTRUCTIONS_KEY, PENDING_NAMES_KEY].map((k) => [
          k,
          this.store.get(k) ?? {},
        ]),
      );
      if (!uid) return;
      this.stop = this.api.listen(
        this.fb.db,
        paths.notes(uid),
        (docs, fromCache) => {
          this.snapshot.set({ uid, docs });
          // Kept writes are checked against the first snapshot from the
          // server, never the persisted cache: that can be stale, showing
          // the base while someone has written over it since (review on
          // #204). Offline, they wait on the device for the server.
          if (!fromCache && !this.replayed) {
            this.replayed = true;
            this.settlePendingShares();
            // Saves held on the device for the key since sign-in are
            // replayed here too: nothing else wakes them when the key
            // came before this snapshot (review on #276, a fresh device
            // back online kept its words held until a reload).
            const held = this.store.get<PendingSaves>(PENDING_SAVES_KEY) ?? {};
            for (const id of this.heldIds()) {
              if (held[id])
                this.atLoad[PENDING_SAVES_KEY] = {
                  ...this.atLoad[PENDING_SAVES_KEY],
                  [id]: held[id],
                };
            }
            this.replayKept();
          }
          this.loaded.set(true);
          this.makePendingConcepts();
        },
        (err) => console.error('notes listener', err),
      );
    });
    // Kept writes for a note that was locked wait for it to open (step
    // 3a): neither replayed over its placeholder nor forgotten.
    effect(() => {
      this.lockedIds();
      untracked(() => {
        if (this.replayed && Object.values(this.atLoad).some((e) => Object.keys(e).length)) {
          this.replayKept();
        }
      });
    });
    // Words held for the key (2026-11-15) are written once it is here,
    // sealed: after the first snapshot from the server, as every kept
    // write. A new note's held words go sooner, as soon as the notes
    // have loaded from the cache (`writeHeldNew`): nothing on the server
    // is theirs to check against, and waiting for the server left a new
    // note out of every list for as long as that took, a reload starting
    // the wait again (review of #276, the share journey). The key is the
    // only thing they wait on.
    effect(() => {
      const key = this.keys.key();
      const loaded = this.loaded();
      untracked(() => {
        if (!key) return;
        if (this.replayed) {
          if (this.heldIds().size || this.keyWaited) this.replayForKey();
        } else if (loaded && this.heldIds().size) this.writeHeldNew();
      });
    });
    // Concepts waiting for the server are made when it is back.
    const back = () => {
      this.makePendingConcepts();
      this.settlePendingShares();
    };
    globalThis.addEventListener?.('online', back);
    globalThis.addEventListener?.('storage', this.copyWritesChanged as EventListener);
    inject(DestroyRef).onDestroy(() => {
      this.stop?.();
      globalThis.removeEventListener?.('online', back);
      globalThis.removeEventListener?.('storage', this.copyWritesChanged as EventListener);
    });
  }

  /**
   * Whether writes can happen yet: the user is known and their notes
   * have loaded, so `save` can tell a new note from an existing one.
   * Before that, a full write could overwrite a note this device has
   * not seen yet.
   */
  get ready(): boolean {
    // Not the key: typing is accepted at once, and `save` holds it on
    // the device until the key is here.
    return this.uid !== undefined && this.loaded();
  }

  newId(): string {
    return autoId(this.random);
  }

  find(id: string): NoteRecord | undefined {
    return this.notes().find((n) => n.id === id);
  }

  exists(id: string): boolean {
    return this.written.has(id) || this.find(id) !== undefined || this.heldIds().has(id);
  }

  /**
   * Whether `id`'s words are held on this device for the key (no key
   * yet, 2026-11-15): kept here, written sealed once it is.
   */
  heldForKey(id: string): boolean {
    return this.heldIds().has(id);
  }

  /**
   * The words held on this device for note `id` for the key, and the
   * text they were typed over as the server had it (`base`, none for a
   * note not on the server yet): what the editor shows after a reload,
   * merged over the note's text now, so typing goes on from them and
   * never starts over the server's (review on #276: an existing note's
   * held save was the only copy).
   */
  heldSave(id: string): { value: string; base?: string } | undefined {
    if (!this.uid) return undefined;
    const entry = (this.store.get<PendingSaves>(PENDING_SAVES_KEY) ?? {})[id];
    if (!isPendingWrite(entry) || entry.uid !== this.uid || !entry.held) return undefined;
    return {
      value: entry.value,
      ...(entry.held.base === undefined ? {} : { base: entry.held.base }),
    };
  }

  /** The ids whose saves this device holds for the key, from its store. */
  private heldInStore(uid: string): Set<string> {
    const pending = this.store.get<PendingSaves>(PENDING_SAVES_KEY) ?? {};
    return new Set(
      Object.entries(pending)
        .filter(([, e]) => isPendingWrite(e) && e.uid === uid && !!e.held)
        .map(([id]) => id),
    );
  }

  private hold(id: string, held: boolean): void {
    if (this.heldIds().has(id) === held) return;
    const next = new Set(this.heldIds());
    if (held) next.add(id);
    else next.delete(id);
    this.heldIds.set(next);
  }

  /** Held for the key and on no server yet: nothing may be written to it until its text is. */
  private heldNew(id: string): boolean {
    return this.heldIds().has(id) && !this.written.has(id) && this.find(id) === undefined;
  }

  /**
   * A write to note text at `path` as it goes out (2026-11-15), for a
   * note of this gardener's: every sealed field it holds is sealed, a
   * list element by element, under the note's id with this device's
   * key. Note text is always written sealed. Without the key a write
   * that holds note text is refused (KeyWaitError), so none goes out in
   * the clear, and a kept write waits for it; a write that holds none
   * (archive, Trash, tags) needs no key. A write to a note held for the
   * key and not written yet is refused too, so no part of it is written
   * before its text. With the key it is synchronous: nothing waits.
   */
  private sealWrite(
    path: string,
    data: Record<string, unknown>,
    merge: boolean,
  ): Record<string, unknown> {
    if (!this.uid) return data;
    const prefix = `${paths.notes(this.uid)}/`;
    if (!path.startsWith(prefix)) return data;
    const id = path.slice(prefix.length);
    if (id.includes('/')) return data;
    if (this.heldNew(id)) {
      this.refusedForKey();
      throw new KeyWaitError('not written: the note waits on this device for its key');
    }
    let out = data;
    for (const field of SEALED_FIELDS) {
      const value = fieldValue(out, field);
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      if (values.every(isSealed)) continue;
      const key = this.keys.key();
      if (!key) {
        this.keyWaited = true;
        // A note made whole in this write is not made yet.
        if (!merge) this.written.delete(id);
        this.refusedForKey();
        throw new KeyWaitError('not written: the key is not on this device yet');
      }
      const aad = aadFor(this.uid, id, field);
      const one = (v: string) => (isSealed(v) ? v : sealText(key, aad, v));
      out = withFieldValue(out, field, Array.isArray(value) ? value.map(one) : one(value));
    }
    return out;
  }

  /**
   * The held saves of notes not on the server (a new note's, `base`
   * null), written now that the key is here, before the first snapshot
   * from the server: a full write of a new id, as `save` made before
   * #276. An existing note's held save still waits for the server's
   * snapshot, which says whether the note is there.
   */
  private writeHeldNew(): void {
    const uid = this.uid;
    const pending = this.store.get<PendingSaves>(PENDING_SAVES_KEY) ?? {};
    for (const id of this.heldIds()) {
      const entry = pending[id];
      if (!uid || !isPendingWrite(entry) || entry.uid !== uid || !entry.held) continue;
      if (entry.base !== null || this.find(id) || this.locked(id)) continue;
      // Not one in Trash (review on #277): its held words wait for the
      // server's snapshot, as before, and go into the trashed note.
      if (this.trashed(id)) continue;
      this.save(id, entry.value, {
        ...(entry.held.base === undefined ? {} : { base: entry.held.base }),
        restore: entry.as === 'restore',
        keep: entry.as === 'keep',
      });
    }
  }

  /** A write refused for want of the key: said on the page, unless it is kept. */
  private refusedForKey(): void {
    if (!this.keptWrite) this.notice.say();
  }

  /** `write`, a kept write's, made with `keptWrite` set (see there). */
  private asKept<T>(write: () => T): T {
    this.keptWrite = true;
    try {
      return write();
    } finally {
      this.keptWrite = false;
    }
  }

  /**
   * The key is here (2026-11-15): every kept write as it stands is
   * checked and written again, as at a load (#200), and the words held
   * for the key are written, sealed.
   */
  private replayForKey(): void {
    this.keyWaited = false;
    this.notice.clear();
    this.atLoad = Object.fromEntries(
      [PENDING_SAVES_KEY, PENDING_INSTRUCTIONS_KEY, PENDING_NAMES_KEY].map((k) => [
        k,
        this.store.get(k) ?? {},
      ]),
    );
    this.replayKept();
  }

  /** The note `id` if it is in Trash (#217). */
  trashed(id: string): NoteRecord | undefined {
    return this.trash().find((n) => n.id === id);
  }

  /**
   * Whether `id` is sealed and this device cannot open it yet (step 3a),
   * in the list or in Trash. Nothing writes to it until it opens.
   */
  locked(id: string): boolean {
    return (this.find(id) ?? this.trashed(id))?.locked === true;
  }

  /** Note `id`'s document as the latest snapshot stored it, sealed values as they are. */
  private storedDoc(id: string): Record<string, unknown> | undefined {
    return this.snapshot()?.docs.find((d) => d.id === id)?.data;
  }

  /**
   * `text` as the app writes field `field` of note `id` (step 3d,
   * 2026-11-13): sealed under the note's id with this device's key, as
   * every field is since 2026-11-15. Without the key this throws
   * KeyWaitError, so the write is refused and a kept write waits for
   * the key (`replayForKey`): no text is written in the clear.
   */
  private inForm<T extends string | string[]>(id: string, field: SealedField, text: T): T {
    const key = this.keys.key();
    if (!this.uid || !key) {
      this.keyWaited = true;
      this.refusedForKey();
      throw new KeyWaitError('not written: the key is not on this device yet');
    }
    const aad = aadFor(this.uid, id, field);
    return (
      Array.isArray(text) ? text.map((t) => sealText(key, aad, t)) : sealText(key, aad, text)
    ) as T;
  }

  /**
   * A merged write to note `id` of what `build` gives; a write it cannot
   * build (a field it cannot seal, `inForm`) is refused, as a rejected
   * write, so its caller keeps what it kept.
   */
  private writeFields(id: string, build: () => Record<string, unknown>): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = build();
    } catch (err) {
      return Promise.reject(err);
    }
    return this.api.set(this.fb.db, paths.note(this.uid!, id), data, true);
  }

  /** Whether `path` is the document of a locked note. */
  private lockedAt(path: string): boolean {
    if (!this.uid) return false;
    const prefix = `${paths.notes(this.uid)}/`;
    if (!path.startsWith(prefix)) return false;
    const id = path.slice(prefix.length);
    return !id.includes('/') && this.locked(id);
  }

  /**
   * The kept writes this sign-in found, checked against the server's
   * notes (#200). Each replay leaves in `atLoad` only the entries whose
   * note is locked, to try again once it opens.
   */
  private replayKept(): void {
    this.replaySaves();
    this.replayInstructions();
    this.replayNames();
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
    // Never over a note this device cannot open (step 3a): its record's
    // text is a placeholder. Capture keeps typing for it on the device.
    if (this.locked(id)) return;
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
    const as = restore ? 'restore' : keep ? 'keep' : undefined;
    const pending = this.store.get<PendingSaves>(PENDING_SAVES_KEY) ?? {};
    const prev = isPendingWrite(pending[id]) ? pending[id] : undefined;
    const { held: wasHeld, ...next } = {
      ...nextPending(prev, this.uid, body, existing?.body ?? null),
      as,
    } as PendingSaves[string];
    // No key here (2026-11-15): the words are kept on the device, never
    // written in the clear, and written sealed once the key arrives
    // (`replayForKey`), over the base they were typed over. The key is
    // the only reason a save is held; with it, a save goes straight into
    // the persistent cache below.
    if (!this.keys.key()) {
      // The base: the one given, when it is what the server has now (the
      // editor merged the server's text in); else the one first held,
      // since a base typed on this device never reached the server.
      const first = prev?.held ?? wasHeld;
      const current = base !== undefined && base === existing?.body;
      const held = { ...next, held: current || !first ? { base } : first };
      this.store.set(PENDING_SAVES_KEY, { ...pending, [id]: held });
      this.hold(id, true);
      return;
    }
    // What this text was written over, so a write over a newer text
    // (Claude's, another device's) is merged on the server (#37). Keyed
    // (2026-11-14, always since 2026-11-15), with the key it is sealed
    // with.
    const baseHash =
      base === undefined ? '' : noteTextHash(id, base, 'sealed', () => this.keys.key());
    if (baseHash === undefined) return;
    const update = { body, ...title, links, baseHash, updatedAt: now, updatedBy: 'user', deviceId };
    // A known note gets a merged update, keeping fields this device did
    // not set (Claude's links, tags, a title). A new one gets the full
    // shape the rules require. One in Trash is known: a full write
    // would replace it, the stamp with it (#217). One held for the key
    // and never written is new.
    const known =
      this.written.has(id) || this.find(id) !== undefined || this.trashed(id) !== undefined;
    const data = known
      ? update
      : { kind: 'text', tags: [], archived: false, createdAt: now, ...update };
    // Kept on this device first, synchronously, until the server has it:
    // the cache takes the write in a moment later, and a page closed in
    // that moment loses it (#200). Replayed on the next load.
    this.store.set(PENDING_SAVES_KEY, { ...pending, [id]: next });
    this.hold(id, false);
    this.written.add(id);
    this.api
      .set(this.fb.db, path, data, known)
      .then(() => this.acknowledged(PENDING_SAVES_KEY, id, body))
      .catch(report);
  }

  /**
   * Once the server's first snapshot is here, the note text a closed
   * page did not get into the cache (#200), written again where `lost`
   * says it was lost. A new note (null base) absent from the server is
   * the lost case itself, so it is made again; its id is fresh and only
   * this device knew it. Any other note absent from the server was
   * deleted, and stays gone.
   */
  private replaySaves(): void {
    const uid = this.uid;
    const atLoad = (this.atLoad[PENDING_SAVES_KEY] ?? {}) as PendingSaves;
    const waiting: PendingSaves = {};
    this.atLoad[PENDING_SAVES_KEY] = waiting;
    for (const [id, entry] of Object.entries(atLoad)) {
      if (!this.unchanged(PENDING_SAVES_KEY, id, entry)) continue;
      // Locked: its text is not known here, so neither replayed nor
      // dropped; it waits for the note to open.
      if (this.locked(id)) {
        waiting[id] = entry;
        continue;
      }
      if (!isPendingWrite(entry) || !uid) {
        this.forget(PENDING_SAVES_KEY, id);
        continue;
      }
      if (entry.uid !== uid) continue;
      // Words typed before a delete are the trashed note's (#217).
      const note = this.find(id) ?? this.trashed(id);
      const now = note ? note.body : null;
      // Held for the key (2026-11-15): never written, so not lost but
      // waiting. Written now over the base they were typed over, and
      // merged on the server if the note moved on; held again while the
      // key is still missing. A note gone from the server stays gone.
      const { held } = entry as PendingSaves[string];
      if (held) {
        if (note || entry.base === null) {
          this.save(id, entry.value, {
            ...(held.base === undefined ? {} : { base: held.base }),
            restore: entry.as === 'restore',
            keep: entry.as === 'keep',
          });
        } else {
          this.forget(PENDING_SAVES_KEY, id);
          this.hold(id, false);
        }
        continue;
      }
      if (lost(entry, now)) {
        this.save(id, entry.value, {
          ...(now === null ? {} : { base: now }),
          restore: entry.as === 'restore',
          keep: entry.as === 'keep',
        });
      } else this.forget(PENDING_SAVES_KEY, id);
    }
  }

  /** Whether `id`'s kept write is still the one this sign-in found. */
  private unchanged(key: string, id: string, entry: unknown): boolean {
    const now = (this.store.get<Record<string, unknown>>(key) ?? {})[id];
    return JSON.stringify(now) === JSON.stringify(entry);
  }

  /** The server has `value` for `id`: forget it, unless newer words wait. */
  private acknowledged(key: string, id: string, value: string): void {
    const pending = this.store.get<PendingWrites>(key) ?? {};
    if (pending[id]?.value === value) this.forget(key, id);
  }

  private forget(key: string, id: string): void {
    const { [id]: _done, ...rest } = this.store.get<PendingWrites>(key) ?? {};
    if (Object.keys(rest).length) this.store.set(key, rest);
    else this.store.remove(key);
  }

  /**
   * Writes a new note in its full shape at once, for a note that must
   * exist before anyone types in it: a template, or a note made from one
   * (#38). The id is fresh, so nothing can be overwritten.
   */
  create(
    id: string,
    body: string,
    fields: {
      kind?: 'text' | 'template';
      templateMode?: string;
      fromTemplate?: string;
      instructions?: string;
      /** A week's grocery list (#207): its week, and its own name. */
      periodStart?: string;
      title?: string;
      titleSource?: 'user';
    } = {},
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

  /**
   * An article filed from the Reader (#163): a note of kind clipping,
   * titled as the article is (`titleSource: 'user'`, so no settle
   * retitles it), its source the page and the item. Written at once,
   * through the cache, so it works offline; returns its id.
   */
  clip(body: string, title: string, source: { url?: string; feedItemId: string }): string {
    if (!this.uid) throw new Error('clip before sign-in');
    const id = this.newId();
    const now = this.api.serverTime();
    const data = {
      kind: 'clipping',
      body,
      title: title.trim() || 'Clipping',
      titleSource: 'user',
      // A clipping's words are a page's, escaped by the fetcher: no links.
      links: [],
      tags: [],
      archived: false,
      source,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.written.add(id);
    this.api.set(this.fb.db, paths.note(this.uid, id), data, false).catch(report);
    return id;
  }

  /**
   * A note's Instructions for Claude, its own field: a template's (#111),
   * never in the text a note made from it starts with, or since #231
   * any note's that takes them (`takesInstructions`).
   */
  setInstructions(id: string, instructions: string): void {
    if (!this.holdInstructions(id, instructions) || !this.uid) return;
    // In the form the note keeps them (step 3d); kept until written.
    this.asKept(() =>
      this.writeFields(id, () => ({
        instructions: this.inForm(id, 'instructions', instructions),
        updatedAt: this.api.serverTime(),
        updatedBy: 'user',
        deviceId: this.deviceId(),
      })),
    )
      .then(() => this.acknowledged(PENDING_INSTRUCTIONS_KEY, id, instructions))
      .catch(report);
  }

  /**
   * Keeps Instructions for Claude on this device, synchronously, without
   * writing them yet (#200): the field calls it on every keystroke and
   * writes after a pause, so words typed when the page closes are kept
   * even though no write has started. False for no such note, or one
   * whose kind takes no instructions.
   */
  holdInstructions(id: string, instructions: string): boolean {
    const note = this.find(id);
    if (!this.uid || !note || note.locked || !takesInstructions(note.kind)) return false;
    const pending = this.store.get<PendingWrites>(PENDING_INSTRUCTIONS_KEY) ?? {};
    const prev = isPendingWrite(pending[id]) ? pending[id] : undefined;
    const entry = nextPending(prev, this.uid, instructions, note.instructions ?? null);
    this.store.set(PENDING_INSTRUCTIONS_KEY, { ...pending, [id]: entry });
    return true;
  }

  /**
   * Once the server's first snapshot is here, the instructions a closed
   * page did not get into the cache (#198, #200), written again where
   * `lost` says they were lost. A note absent from the server was
   * deleted or never synced: its entry goes.
   */
  private replayInstructions(): void {
    const atLoad = this.atLoad[PENDING_INSTRUCTIONS_KEY] ?? {};
    const waiting: PendingWrites = {};
    this.atLoad[PENDING_INSTRUCTIONS_KEY] = waiting;
    for (const [id, entry] of Object.entries(atLoad)) {
      if (!this.unchanged(PENDING_INSTRUCTIONS_KEY, id, entry)) continue;
      if (this.locked(id)) {
        waiting[id] = entry;
        continue;
      }
      if (!isPendingWrite(entry)) {
        this.forget(PENDING_INSTRUCTIONS_KEY, id);
        continue;
      }
      if (entry.uid !== this.uid) continue;
      const note = this.find(id);
      if (note && takesInstructions(note.kind) && lost(entry, note.instructions ?? null)) {
        this.setInstructions(id, entry.value);
      } else this.forget(PENDING_INSTRUCTIONS_KEY, id);
    }
  }

  /**
   * The context note (#113), made if absent: only if absent, in a
   * transaction, so it never replaces the one another device or Claude
   * made. Needs the server; until then, it is made on the next try.
   */
  async makeContext(): Promise<void> {
    if (!this.uid || this.exists(CONTEXT_ID)) return;
    const now = this.api.serverTime();
    await this.api.createIfAbsent(this.fb.db, paths.note(this.uid, CONTEXT_ID), {
      kind: 'context',
      body: '',
      title: 'Context for Claude',
      // Its name is fixed: a settle never retitles it.
      titleSource: 'user',
      links: [],
      tags: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'user',
      deviceId: this.deviceId(),
    });
  }

  /**
   * A new recipe named `name` (#127), its sections ready to fill. Written
   * at once, through the cache, so it works offline; its id is generated.
   * Refused (undefined) when the name already answers to another note,
   * so a `[[link]]` to it can only mean one thing. An empty stub concept
   * holding the name (a link written before the recipe) is folded in,
   * archived with `mergedInto`, as a renamed concept folds one (#30).
   */
  createRecipe(name: string, more: Record<string, unknown> = {}): string | undefined {
    return this.makeRecipe(name, more, this.newId())?.id;
  }

  /** As `createRecipe`, under `id`, with the write's promise. */
  private makeRecipe(
    name: string,
    more: Record<string, unknown>,
    id: string,
  ): { id: string; written: Promise<void> } | undefined {
    const title = name.trim();
    if (!this.uid || !title) return undefined;
    const owner = this.names().get(normalizeName(title));
    const stub = owner === undefined ? undefined : this.find(owner);
    const foldable =
      stub?.kind === 'concept' && !stub.locked && !stub.body.trim() && !stub.synonyms?.length;
    if (owner !== undefined && !foldable) return undefined;
    const now = this.api.serverTime();
    this.written.add(id);
    const data = {
      kind: 'recipe',
      body: recipeSkeleton(),
      title,
      // The name is Eric's: a settle never retitles a recipe.
      titleSource: 'user',
      links: [],
      tags: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'user',
      deviceId: this.deviceId(),
      ...more,
    };
    const written = this.api.set(this.fb.db, paths.note(this.uid, id), data, false);
    written.catch(report);
    if (foldable && owner) {
      const merged = {
        archived: true,
        mergedInto: id,
        updatedAt: now,
        updatedBy: 'user',
        deviceId: this.deviceId(),
      };
      this.api.set(this.fb.db, paths.note(this.uid, owner), merged, true).catch(report);
    }
    return { id, written };
  }

  /**
   * A recipe imported from a link (#128), written at once like New
   * recipe, offline too: its empty sections, the link as its source, a
   * placeholder name ("Recipe from example.com", numbered when taken)
   * and `importState: 'requested'`, which asks the server to read the
   * page and fill it in. Undefined for a link that is not http(s).
   */
  importRecipe(url: string): string | undefined {
    const link = url.trim();
    if (!this.uid || !/^https?:\/\/[^/\s]+/i.test(link)) return undefined;
    let n = 1;
    while (this.names().has(normalizeName(importPlaceholder(link, n)))) n++;
    return this.createRecipe(importPlaceholder(link, n), {
      source: { url: link },
      importState: 'requested',
    });
  }

  /**
   * A recipe to be read from words shared from its page (2026-11-14,
   * DESIGN.md, Share to Mossgoblin): Eric's own write, like Import from
   * a link, with the link as its source and the placeholder name, but
   * made as an import that has already failed, with a calm reason. The
   * trigger reads only `requested`, so it never claims this one; the
   * share hands the words to `importPastedRecipe`, as Paste the page
   * instead does, once the server has the recipe (`written`). `id` is
   * chosen and kept with the share first, so asking again never makes a
   * second recipe. After a reload, a recipe already on this device has
   * no write to wait on here; the share page asks again while the
   * server says it has no such recipe yet (review on #271). Undefined
   * for a link that is not http(s).
   */
  sharedRecipe(url: string, id: string): Promise<void> | undefined {
    const link = url.trim();
    if (!this.uid || !/^https?:\/\/[^/\s]+/i.test(link)) return undefined;
    if (this.exists(id)) return this.sharedWrites.get(id) ?? Promise.resolve();
    let n = 1;
    while (this.names().has(normalizeName(importPlaceholder(link, n)))) n++;
    const written = this.makeRecipe(
      importPlaceholder(link, n),
      { source: { url: link }, importState: 'failed', importError: SHARED_IMPORT_WAITING },
      id,
    )?.written;
    if (written) this.sharedWrites.set(id, written);
    return written;
  }

  /** The writes of recipes made from shares this load, until the server has them. */
  private readonly sharedWrites = new Map<string, Promise<void>>();

  /**
   * A recipe a share made (`sharedRecipe`) that the share then went
   * another way (kept as a note, or let go; review on #271): moved to
   * Trash, the app's own delete, if it is still the failed stub the
   * share made (its sections empty, the placeholder name, the share's
   * link and no original text); left as it is if anyone changed it.
   */
  dropSharedRecipe(id: string, url: string): boolean {
    const note = this.find(id);
    if (!this.uid || note?.kind !== 'recipe' || note.locked) return false;
    const stub =
      note.importState === 'failed' &&
      untouchedRecipe(note.body) &&
      isImportPlaceholder(note.title, url.trim()) &&
      note.source?.url === url.trim() &&
      !note.source.text;
    if (!stub) return false;
    this.setDeleted(id, true);
    return true;
  }

  /** Why an import failed, as the server said, on the recipe's front. */
  importFailed(id: string, why: string): void {
    const note = this.find(id);
    if (!this.uid || note?.kind !== 'recipe') return;
    // In the form the note keeps it (step 3d), as any sealed field.
    this.writeFields(id, () => ({
      importError: this.inForm(id, 'importError', why.slice(0, 500)),
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    })).catch(report);
  }

  /**
   * The meal plan for the week starting `start` (#129), made now if this
   * device has not seen it: its slots from Kitchen's configuration, and
   * the "Fish of the week" placeholder recipe if nothing has that name.
   * The id is derived, so every device and Claude make the same note.
   * Undefined until the notes are here, since a plan another device
   * made must not be written over.
   */
  ensurePlan(start: string, config: KitchenConfig): string | undefined {
    const id = planId(start);
    if (this.exists(id)) return id;
    if (!this.uid || !this.ready) return undefined;
    const now = this.api.serverTime();
    const stamp = {
      archived: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    const body = planBody(start, config);
    if (body.includes(`[[${FISH_NAME}]]`) && !this.names().has(normalizeName(FISH_NAME))) {
      this.written.add(FISH_ID);
      const fish = {
        ...stamp,
        kind: 'recipe',
        body: FISH_BODY,
        title: FISH_NAME,
        titleSource: 'user',
        links: [],
        tags: [],
      };
      this.api.set(this.fb.db, paths.note(this.uid, FISH_ID), fish, false).catch(report);
    }
    const names = new Map(this.names()).set(normalizeName(FISH_NAME), FISH_ID);
    const data = {
      ...stamp,
      kind: 'mealplan',
      body,
      title: planTitle(start),
      titleSource: 'user',
      periodStart: start,
      links: resolveLinks(wikiLinkTargets(parseNote(body)), names),
      tags: [],
    };
    this.written.add(id);
    this.api.set(this.fb.db, paths.note(this.uid, id), data, false).catch(report);
    return id;
  }

  /**
   * What is on hand (#131): the pantry note, made now if this device has
   * not seen it, with its name and the store's sections. Its id is
   * fixed, like the context note's. Undefined until the notes are here.
   */
  ensurePantry(): string | undefined {
    if (this.exists(PANTRY_ID)) return PANTRY_ID;
    if (!this.uid || !this.ready) return undefined;
    const now = this.api.serverTime();
    const data = {
      kind: 'pantry',
      body: PANTRY_BODY,
      title: PANTRY_TITLE,
      titleSource: 'user',
      links: [],
      tags: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.written.add(PANTRY_ID);
    this.api.set(this.fb.db, paths.note(this.uid, PANTRY_ID), data, false).catch(report);
    return PANTRY_ID;
  }

  /** A line under a recipe's Notes (#129: how a dinner went). */
  addRecipeNote(id: string, line: string): void {
    const recipe = this.find(id);
    if (!this.uid || recipe?.kind !== 'recipe') return;
    this.save(id, addRecipeNote(recipe.body, line), { base: recipe.body });
  }

  /** Asks again for an import that failed (#128). */
  retryImport(id: string): void {
    const note = this.find(id);
    if (!this.uid || note?.kind !== 'recipe' || !note.source?.url) return;
    const update = {
      importState: 'requested',
      importError: this.api.removeField(),
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.api.set(this.fb.db, paths.note(this.uid, id), update, true).catch(report);
  }

  /**
   * Dismiss (2026-11-15): a recipe whose import failed made an ordinary
   * recipe, its import state and reason removed and its link kept as
   * its source, for one Eric has filled in another way.
   */
  dismissImport(id: string): void {
    const note = this.find(id);
    if (!this.uid || note?.kind !== 'recipe' || note.importState !== 'failed') return;
    this.writeFields(id, () => ({
      importState: this.api.removeField(),
      importError: this.api.removeField(),
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    })).catch(report);
  }

  /**
   * Sends a note to Eric's assistant (#143): it waits, with what he
   * asks, until his assistant next checks (list_queue). Through the
   * cache like any write, so it works offline. Sending again replaces
   * the ask and clears what was done before.
   */
  sendToAssistant(id: string, ask: string): void {
    if (!this.uid || !this.exists(id)) return;
    // Cut to its limit as plain text, before any sealing (2026-11-13).
    const text = ask.replace(/\s+/g, ' ').trim().slice(0, SEND_ASK_MAX);
    this.writeFields(id, () => ({
      sendState: 'queued',
      // In the form the note keeps it (step 3d).
      sendAsk: text ? this.inForm(id, 'sendAsk', text) : this.api.removeField(),
      sentAt: this.api.serverTime(),
      sendOutcome: this.api.removeField(),
      // Sent by Eric now, not on its arrival (#214).
      sentOnArrival: this.api.removeField(),
    })).catch(report);
  }

  /** Takes a sent note out of the queue, or clears what was done (#143). */
  unsend(id: string): void {
    if (!this.uid || !this.find(id)?.sendState) return;
    const gone = this.api.removeField();
    const update = {
      sendState: gone,
      sendAsk: gone,
      sentAt: gone,
      sendOutcome: gone,
      sendRun: gone,
      sentOnArrival: gone,
    };
    this.api.set(this.fb.db, paths.note(this.uid, id), update, true).catch(report);
  }

  /** A recipe's name (Eric's own), servings or source link (#127). */
  updateRecipe(
    id: string,
    change: { title?: string; servings?: number | null; url?: string },
  ): void {
    this.writeRecipe(id, change)?.catch(report);
  }

  /** `updateRecipe`'s write, undefined when nothing was written. */
  private writeRecipe(
    id: string,
    change: { title?: string; servings?: number | null; url?: string },
  ): Promise<void> | undefined {
    if (!this.uid || this.find(id)?.kind !== 'recipe') return undefined;
    const update: Record<string, unknown> = {};
    const title = change.title?.trim();
    if (title && title !== this.find(id)?.title) {
      const owner = this.names().get(normalizeName(title));
      if (owner !== undefined && owner !== id) return undefined;
      update['title'] = title;
      update['titleSource'] = 'user';
    }
    if (change.servings === null) update['servings'] = this.api.removeField();
    else if (change.servings !== undefined && change.servings > 0) {
      update['servings'] = change.servings;
    }
    if (change.url !== undefined) {
      // The rest of the source as stored: its text, sealed or not, is
      // written back as it was, never as this device read it (step 3d).
      const source = this.storedDoc(id)?.['source'];
      const kept = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
      update['source'] = { ...kept, url: change.url.trim() };
    }
    if (Object.keys(update).length === 0) return undefined;
    const stamp = {
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    return this.api.set(this.fb.db, paths.note(this.uid, id), { ...update, ...stamp }, true);
  }

  /**
   * Keeps a recipe's or a concept's name on this device, synchronously,
   * without writing it yet (#205): the field calls it on every keystroke,
   * so a name typed when the page closes is kept though no write has
   * started. A blank name is no name (leaving the field puts the note's
   * back), so it keeps nothing and forgets what was kept. False for a
   * blank name or no such note.
   */
  holdName(id: string, name: string): boolean {
    const note = this.find(id);
    const title = name.trim();
    if (!this.uid || (note?.kind !== 'recipe' && note?.kind !== 'concept')) return false;
    // A locked note's name is not known here: nothing kept, nothing forgotten.
    if (note.locked) return false;
    if (!title) {
      this.forget(PENDING_NAMES_KEY, id);
      return false;
    }
    const pending = this.store.get<PendingWrites>(PENDING_NAMES_KEY) ?? {};
    const prev = isPendingWrite(pending[id]) ? pending[id] : undefined;
    const entry = nextPending(prev, this.uid, title, note.title);
    this.store.set(PENDING_NAMES_KEY, { ...pending, [id]: entry });
    return true;
  }

  /**
   * Renames a recipe or a concept through its own path (`updateRecipe`,
   * `updateConcept`: a concept's old name becomes another name, and an
   * empty stub holding the new one is folded in), kept on this device
   * until the server has it (#205). A name another note answers to is
   * refused and not kept; the refused names are returned.
   */
  rename(id: string, name: string): string[] {
    if (!this.holdName(id, name)) return [];
    const title = name.trim();
    const concept = this.find(id)?.kind === 'concept';
    const { refused, written } = this.asKept(() =>
      concept
        ? this.writeConcept(id, { title })
        : { refused: [] as string[], written: this.writeRecipe(id, { title }) },
    );
    if (written) {
      written.then(() => this.acknowledged(PENDING_NAMES_KEY, id, title)).catch(report);
    } else if (this.find(id)?.title !== title) {
      // Nothing written over another name: the name is taken.
      this.forget(PENDING_NAMES_KEY, id);
      return concept ? refused : [title];
    }
    return refused;
  }

  /**
   * Once the server's first snapshot is here, the names a closed page did
   * not get into the cache (#205), renamed again where `lost` says they
   * were lost, through `rename`, so a concept's old name is kept and a
   * stub folded as when it was typed. A note the server lacks drops its
   * entry.
   */
  private replayNames(): void {
    const atLoad = this.atLoad[PENDING_NAMES_KEY] ?? {};
    const waiting: PendingWrites = {};
    this.atLoad[PENDING_NAMES_KEY] = waiting;
    for (const [id, entry] of Object.entries(atLoad)) {
      if (!this.unchanged(PENDING_NAMES_KEY, id, entry)) continue;
      if (this.locked(id)) {
        waiting[id] = entry;
        continue;
      }
      if (!isPendingWrite(entry)) {
        this.forget(PENDING_NAMES_KEY, id);
        continue;
      }
      if (entry.uid !== this.uid) continue;
      const note = this.find(id);
      const named = note?.kind === 'recipe' || note?.kind === 'concept';
      if (named && lost(entry, note.title)) this.rename(id, entry.value);
      else this.forget(PENDING_NAMES_KEY, id);
    }
  }

  /**
   * Archives a note, or restores it (#207): Eric's own edit, through the
   * cache like any write, so it works offline. Nothing is deleted; an
   * archived note keeps its History and shows under Browse, Archived.
   */
  setArchived(id: string, archived: boolean): void {
    if (!this.uid || !this.exists(id)) return;
    const update = {
      archived,
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.api.set(this.fb.db, paths.note(this.uid, id), update, true).catch(report);
  }

  /**
   * Puts a note in Trash, or takes it out (#217): Eric's own edit,
   * through the cache like `setArchived`, so it works offline. A
   * tombstone, `deletedAt` on the device's clock as other client
   * stamps are; History and Put back still reach the note, and Restore
   * brings it back as it was, archived or not. The sweep removes it for
   * good `TRASH_DAYS` after the stamp.
   */
  setDeleted(id: string, deleted: boolean): void {
    if (!this.uid) return;
    if (deleted ? !this.exists(id) : !this.trashed(id)) return;
    // Known from here on by the snapshot, in Trash or back in the list.
    if (deleted) this.written.delete(id);
    // A note in Trash is not shared (2026-11-26): its public copy goes
    // with the same tap, and Restore does not bring it back.
    const shared = deleted ? this.find(id)?.shareId : undefined;
    const update = {
      deletedAt: deleted ? this.api.timestamp(this.now()) : this.api.removeField(),
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
      ...(shared ? { shareId: this.api.removeField() } : {}),
    };
    if (shared) {
      // One batch: the copy is never left public behind a note in Trash.
      this.shareWrite(shared, id, 'stop', [
        { path: paths.share(shared) },
        { path: paths.note(this.uid, id), data: update, merge: true },
      ]);
      return;
    }
    this.api.set(this.fb.db, paths.note(this.uid, id), update, true).catch(report);
  }

  /**
   * Leave this note alone (#229): held, Garden on arrival never sends
   * it. Through the cache like `setArchived`; clearing it sends nothing.
   */
  setGardenHold(id: string, held: boolean): void {
    if (!this.uid || !this.exists(id)) return;
    const update = {
      gardenHold: held,
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.api.set(this.fb.db, paths.note(this.uid, id), update, true).catch(report);
  }

  /**
   * A grocery list from before #207, taken as the week's list: its week
   * stamped in `periodStart`, through the cache like `setArchived`.
   */
  setWeek(id: string, periodStart: string): void {
    if (!this.uid || !this.exists(id)) return;
    const update = {
      periodStart,
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.api.set(this.fb.db, paths.note(this.uid, id), update, true).catch(report);
  }

  /**
   * How a note takes new material (#231), or none: Eric's own edit,
   * through the cache like `setArchived`, so it works offline.
   */
  setNoteMode(id: string, mode: NoteMode | undefined): void {
    const note = this.find(id);
    if (!this.uid || !note || !takesInstructions(note.kind)) return;
    const update = {
      mode: mode ?? this.api.removeField(),
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.api.set(this.fb.db, paths.note(this.uid, id), update, true).catch(report);
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
   * A name linked on a Moods line is made a mood (#40).
   */
  plantConcepts(body: string): void {
    const names = this.names();
    const moods = new Set(moodTargets(body).map(normalizeName));
    for (const target of wikiLinkTargets(parseNote(body))) {
      if (names.has(normalizeName(target))) continue;
      this.createConcept(target, moods.has(normalizeName(target)) ? 'mood' : 'other');
    }
  }

  /**
   * Asks for a stub concept for `name` and returns its id. The stub is
   * made in a transaction that writes only if the concept does not
   * exist, so it can never replace a concept another device or Claude
   * made (review on #65). A transaction needs the server: until the
   * notes have loaded and the device is online, the name waits on the
   * device and is made then. A concept in Trash by that name (its id
   * is the name's) comes back instead, as Restore brings it (review on
   * #230): its text and filing as they were.
   */
  createConcept(name: string, type: 'other' | 'mood' = 'other'): string {
    const id = conceptId(name);
    if (this.exists(id)) return id;
    if (this.trashed(id)) {
      this.setDeleted(id, false);
      return id;
    }
    const pending = this.store.get<string[]>(PENDING_CONCEPTS_KEY) ?? [];
    if (!pending.some((n) => conceptId(n) === id)) {
      this.store.set(PENDING_CONCEPTS_KEY, [...pending, name.trim()]);
    }
    const moods = this.store.get<string[]>(PENDING_MOODS_KEY) ?? [];
    if (type === 'mood' && !moods.includes(id)) this.store.set(PENDING_MOODS_KEY, [...moods, id]);
    this.makePendingConcepts();
    return id;
  }

  /**
   * A new item in project `parent` (2026-10-17): a sub-project named
   * `name`, at `stage`. A name a concept already answers to files that
   * concept there instead. Made like any concept: once online.
   */
  createItem(parent: string, name: string, stage?: string): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const known = this.names().get(normalizeName(trimmed));
    if (known !== undefined) {
      // Only a project or a plain concept, and only where it may go: a
      // person stays a person, and a project never goes under its own
      // sub-project (review on #122).
      const concept = this.find(known);
      const type = concept?.conceptType ?? 'other';
      const projects = this.notes().filter((n) => n.conceptType === 'project');
      if (concept?.kind !== 'concept' || (type !== 'project' && type !== 'other')) return undefined;
      if (known === parent || !canParent(known, parent, projects)) return undefined;
      this.updateConcept(known, { conceptType: 'project', parent, ...(stage ? { stage } : {}) });
      return known;
    }
    const id = conceptId(trimmed);
    const items = this.store.get<PendingItems>(PENDING_ITEMS_KEY) ?? {};
    this.store.set(PENDING_ITEMS_KEY, { ...items, [id]: { parent, ...(stage ? { stage } : {}) } });
    return this.createConcept(trimmed);
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
      // Named again while in Trash: brought back, not made (review on #230).
      if (this.trashed(id)) {
        this.setDeleted(id, false);
        this.donePending(id);
        continue;
      }
      if (this.making.has(id)) continue;
      this.making.add(id);
      const now = this.api.serverTime();
      const item = (this.store.get<PendingItems>(PENDING_ITEMS_KEY) ?? {})[id];
      const stub = {
        kind: 'concept',
        body: '',
        title: name,
        // The name is Eric's: a settle never retitles a concept.
        titleSource: 'user',
        conceptType: item
          ? 'project'
          : (this.store.get<string[]>(PENDING_MOODS_KEY) ?? []).includes(id)
            ? 'mood'
            : 'other',
        ...(item ? { parent: item.parent, ...(item.stage ? { stage: item.stage } : {}) } : {}),
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
        // Not made: it is there already. Known here, or in Trash, it is
        // done now; otherwise it waits for the snapshot that shows it, so
        // one in Trash this device has not seen yet still comes back.
        .then((made) => {
          if (made || this.exists(id)) this.donePending(id);
          else if (this.trashed(id)) {
            this.setDeleted(id, false);
            this.donePending(id);
          }
        })
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
    const moods = (this.store.get<string[]>(PENDING_MOODS_KEY) ?? []).filter((m) => m !== id);
    if (moods.length) this.store.set(PENDING_MOODS_KEY, moods);
    else this.store.remove(PENDING_MOODS_KEY);
    const { [id]: _made, ...items } = this.store.get<PendingItems>(PENDING_ITEMS_KEY) ?? {};
    if (Object.keys(items).length) this.store.set(PENDING_ITEMS_KEY, items);
    else this.store.remove(PENDING_ITEMS_KEY);
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
    change: {
      title?: string;
      conceptType?: string;
      synonyms?: string[];
      /** A project's parent; null makes it top level. */
      parent?: string | null;
      projectKind?: ProjectKind;
      projectStatus?: ProjectStatus;
      /** A project's stages and item tags, in order (2026-10-17). */
      stages?: string[];
      itemTags?: string[];
      /** A sub-project's stage; null clears it. */
      stage?: string | null;
      tags?: string[];
    },
  ): string[] {
    const { refused, written } = this.writeConcept(id, change);
    written?.catch(report);
    return refused;
  }

  /** `updateConcept`'s write of the concept, absent when nothing was written. */
  private writeConcept(
    id: string,
    change: Parameters<NotesService['updateConcept']>[1],
  ): { refused: string[]; written?: Promise<void> } {
    const concept = this.find(id);
    if (!this.uid || concept?.kind !== 'concept') return { refused: [] };
    const names = this.names();
    const refused: string[] = [];
    const folded = new Set<string>();
    const free = (name: string) => {
      const owner = names.get(normalizeName(name));
      if (owner === undefined || owner === id) return true;
      const stub = this.find(owner);
      if (stub?.kind === 'concept' && !stub.locked && !stub.body.trim() && !stub.synonyms?.length) {
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
    let unsealable: unknown;
    if (change.synonyms || update['title']) {
      // In the form the note keeps them (step 3d): sealed beside a sealed
      // title too, since a rename keeps the old title among them.
      try {
        update['synonyms'] = this.inForm(id, 'synonyms', clean);
      } catch (err) {
        unsealable = err;
      }
    }
    if (change.conceptType) update['conceptType'] = change.conceptType;
    if (change.parent === null) update['parent'] = this.api.removeField();
    else if (change.parent !== undefined) {
      const projects = this.notes().filter((n) => n.conceptType === 'project');
      if (change.parent !== id && canParent(id, change.parent, projects)) {
        update['parent'] = change.parent;
      }
    }
    if (change.projectKind) update['projectKind'] = change.projectKind;
    if (change.projectStatus) update['projectStatus'] = change.projectStatus;
    const tidy = (list: string[]) => [...new Set(list.map((n) => n.trim()).filter(Boolean))];
    if (change.stages) update['stages'] = tidy(change.stages);
    if (change.itemTags) update['itemTags'] = tidy(change.itemTags);
    if (change.stage === null) update['stage'] = this.api.removeField();
    else if (change.stage !== undefined) update['stage'] = change.stage;
    if (change.tags) update['tags'] = tidy(change.tags);
    // Not written at all rather than without its other names; a rename
    // stays kept (rename) until it can be.
    if (unsealable) return { refused, written: Promise.reject(unsealable) };
    if (Object.keys(update).length === 0) return { refused };
    const path = paths.note(this.uid, id);
    const stamp = {
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    const written = this.api.set(this.fb.db, path, { ...update, ...stamp }, true);
    for (const stub of folded) {
      const merged = { archived: true, mergedInto: id, ...stamp };
      this.api.set(this.fb.db, paths.note(this.uid, stub), merged, true).catch(report);
    }
    return { refused, written };
  }

  /**
   * Marks a note settled (Eric left it), which asks noteTitle for a
   * Claude title. `edited`: the caller saw it typed in and saved, with
   * text. Otherwise only a note with text written since its last settle
   * is settled, so reading an old note never calls Claude. The body and
   * updatedAt are left alone.
   */
  settle(id: string, { edited = false }: { edited?: boolean } = {}): void {
    // A locked note asks no title of a text this device cannot read, nor
    // does one whose words wait here for the key (2026-11-15).
    if (!this.uid || this.locked(id) || this.heldNew(id)) return;
    // A template keeps the name its first line gives it; the context note
    // keeps its own (#113).
    const kind = this.find(id)?.kind;
    if (kind === 'template' || kind === 'context') return;
    // Leaving a note just deleted asks no title of it (#217).
    if (this.trashed(id)) return;
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
    // A locked note is never deleted for looking empty (step 3a).
    if (!this.uid || this.locked(id)) return;
    const shared = (this.find(id) ?? this.trashed(id))?.shareId;
    this.written.delete(id);
    // Emptied or bare: nothing typed in it is left to keep.
    this.forget(PENDING_SAVES_KEY, id);
    this.forget(PENDING_INSTRUCTIONS_KEY, id);
    this.forget(PENDING_NAMES_KEY, id);
    this.hold(id, false);
    this.snapshot.update((snap) => snap && { ...snap, docs: snap.docs.filter((d) => d.id !== id) });
    if (shared) {
      // Its public copy goes with it, in the same batch (2026-11-26).
      this.shareWrite(shared, id, 'stop', [
        { path: paths.share(shared) },
        { path: paths.note(this.uid, id) },
      ]);
      return;
    }
    this.api.remove(this.fb.db, paths.note(this.uid, id)).catch(report);
  }

  /**
   * Why note `id` cannot be shared now (2026-11-26), or undefined when it
   * can: only plain notes and recipes, opened here, their words saved.
   */
  shareRefusal(id: string): string | undefined {
    return shareRefusal(this.find(id), this.heldForKey(id));
  }

  /**
   * Shares a public copy of note `id` (2026-11-26, Eric; DESIGN.md,
   * Sharing a public copy): a new `shares/{shareId}` document with the
   * note's title and body as they are now, and the id on the note, in
   * one batch through the persistent cache, so they never disagree:
   * offline the share is made here and its link works once it syncs. A
   * new id every time, made on this device: a link once stopped never
   * comes back. Returns the id, or undefined when the note cannot be
   * shared.
   */
  share(id: string): string | undefined {
    const note = this.find(id);
    if (!this.uid || !note || note.shareId || this.shareRefusal(id)) return undefined;
    const copy = shareCopyOf(note);
    if (!copy) return undefined;
    const shareId = newShareId(this.random);
    const now = this.api.serverTime();
    const data = { owner: this.uid, noteId: id, ...copy, sharedAt: now, updatedAt: now };
    // The note's own fields stay as they were, its edited time too:
    // sharing is not an edit.
    this.shareWrite(shareId, id, 'share', [
      { path: paths.share(shareId), data },
      { path: paths.note(this.uid, id), data: { shareId }, merge: true },
    ]);
    return shareId;
  }

  /**
   * Writes note `id`'s title and body as they are now over its public
   * copy (Update the shared copy): never on its own, only when asked.
   */
  updateShare(id: string): void {
    const note = this.find(id);
    if (!this.uid || !note?.shareId || this.shareRefusal(id)) return;
    const copy = shareCopyOf(note);
    if (!copy) return;
    const data = {
      ...copy,
      ...(copy.source ? {} : { source: this.api.removeField() }),
      updatedAt: this.api.serverTime(),
    };
    this.shareWrite(note.shareId, id, 'update', [
      { path: paths.share(note.shareId), data, merge: true },
    ]);
  }

  /**
   * Stops sharing note `id`: its public copy is deleted and the note
   * forgets the id, in one batch. Until the server has the batch (this
   * device offline) the copy is still public, and `sharesWaiting` says
   * so. Sharing again makes a new link. A locked note's copy is deleted
   * alone, since nothing is written to a locked note here; the server
   * then takes the id off the note (`shareDeleted`).
   */
  stopShare(id: string): void {
    const note = this.find(id) ?? this.trashed(id);
    if (!this.uid || !note?.shareId) return;
    const writes: BatchWrite[] = [{ path: paths.share(note.shareId) }];
    if (!note.locked) {
      writes.push({
        path: paths.note(this.uid, id),
        data: { shareId: this.api.removeField() },
        merge: true,
      });
    }
    this.shareWrite(note.shareId, id, 'stop', writes);
  }

  /**
   * The signed-in account's public-copy writes this device made that the
   * server does not have yet, or that it refused, by share id
   * (2026-11-26, review of #343). Kept on the device per account, so a
   * stop made offline is still said to be waiting after a reload or a
   * sign-out: Firestore keeps an account's queued writes in its cache
   * when the account signs out and sends them when it signs in here
   * again, so the record keeps them for it too, shown only to it. A
   * shared copy is never said to be gone while it may still be public,
   * nor a refused write said to be done.
   */
  readonly sharesWaiting = computed(() => {
    const uid = this.auth.user()?.uid;
    const all = this.copyWrites();
    return uid
      ? Object.fromEntries(Object.entries(all).filter(([, w]) => w.uid === uid))
      : ({} as Record<string, PublicCopyWrite>);
  });
  private readonly copyWrites = signal<Record<string, PublicCopyWrite>>(this.storedCopyWrites());

  /** Every account's writes as storage holds them now, any other window's included. */
  private storedCopyWrites(): Record<string, PublicCopyWrite> {
    const raw = this.store.get<Record<string, unknown>>(PUBLIC_COPY_WRITES_KEY) ?? {};
    return Object.fromEntries(
      Object.entries(raw).filter((e): e is [string, PublicCopyWrite] => isCopyWrite(e[1])),
    );
  }

  /**
   * Changes the record from what storage holds now, so two windows
   * writing it lose nothing of each other's.
   */
  private changeCopyWrites(
    change: (all: Record<string, PublicCopyWrite>) => Record<string, PublicCopyWrite>,
  ): void {
    const next = change(this.storedCopyWrites());
    if (Object.keys(next).length) this.store.set(PUBLIC_COPY_WRITES_KEY, next);
    else this.store.remove(PUBLIC_COPY_WRITES_KEY);
    this.copyWrites.set(next);
  }

  /** Another window changed the record: show what storage holds now. */
  private readonly copyWritesChanged = (e: StorageEvent) => {
    if (e.key === PUBLIC_COPY_WRITES_KEY || e.key === null) {
      this.copyWrites.set(this.storedCopyWrites());
    }
  };

  /**
   * `writes` as one batch for share `shareId`. Said to wait until the
   * server has it; cleared only when the batch resolves; marked failed
   * when it is refused, and then the cache takes the batch back, so the
   * note shows as it truly is and the page says the act did not happen.
   */
  private shareWrite(
    shareId: string,
    noteId: string,
    op: PublicCopyWrite['op'],
    writes: BatchWrite[],
  ): void {
    const uid = this.uid!;
    const title = (this.find(noteId) ?? this.trashed(noteId))?.title ?? '';
    const entry: PublicCopyWrite = { uid, noteId, title, op, at: this.now() };
    const same = (w: PublicCopyWrite | undefined) => w?.at === entry.at && w.op === op;
    this.changeCopyWrites((all) => {
      // A new act on the note replaces what was said of a refused one.
      const kept = Object.entries(all).filter(
        ([, w]) => !(w.failed && w.uid === uid && w.noteId === noteId),
      );
      return { ...Object.fromEntries(kept), [shareId]: entry };
    });
    this.api.commit(this.fb.db, writes).then(
      () =>
        this.changeCopyWrites((all) => {
          if (!same(all[shareId])) return all;
          const { [shareId]: _done, ...rest } = all;
          return rest;
        }),
      (err) => {
        this.changeCopyWrites((all) =>
          same(all[shareId]) ? { ...all, [shareId]: { ...entry, failed: true } } : all,
        );
        report(err);
      },
    );
  }

  /**
   * The signed-in account's waiting writes from an earlier load: gone
   * once the server has every write this account made so far (Firestore
   * keeps them across a reload and sends them when it can). Never
   * another account's, and never a refused one.
   */
  private settlePendingShares(): void {
    const uid = this.uid;
    if (!uid) return;
    const before = Object.entries(this.copyWrites()).filter(([, w]) => w.uid === uid && !w.failed);
    if (!before.length) return;
    this.api.synced(this.fb.db).then(
      () =>
        this.changeCopyWrites((all) => {
          const out = { ...all };
          for (const [id, w] of before) {
            const now = out[id];
            if (now && now.at === w.at && now.op === w.op && !now.failed) delete out[id];
          }
          return out;
        }),
      () => undefined,
    );
  }

  /** The notes shared now, as Settings, Shared links, lists them: newest edit first. */
  readonly shared = computed(() => this.records().filter((n) => n.shareId !== undefined));

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
  if (err instanceof LockedNoteError) console.warn(err.message);
  else console.error('note write failed', err);
}
