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
  madeHistory,
  planBody,
  planId,
  planTitle,
  recipeSkeleton,
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
  textHash,
  type TitleSource,
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
} from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { LocalStore } from '../platform/local-store';
import { ONLINE, RANDOM_BYTES } from '../platform/platform';

/** Names linked before their concept could be made (needs the server). */
export const PENDING_CONCEPTS_KEY = 'goblin.pendingConcepts';
/** The ids among them to make as moods (#40). */
export const PENDING_MOODS_KEY = 'goblin.pendingMoods';
/** Items waiting to be made, by id: the project they go in, and their stage. */
export const PENDING_ITEMS_KEY = 'goblin.pendingItems';
type PendingItems = Record<string, { parent: string; stage?: string }>;

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
  /** A template's Instructions for Claude, once moved out of its body (#111). */
  instructions?: string;
  /** A recipe's source and servings (#127). */
  source?: { url?: string; attachmentId?: string; text?: string };
  servings?: number;
  /** An import from `source.url` the app asked for (#128), and why it failed. */
  importState?: 'requested' | 'working' | 'done' | 'failed';
  importError?: string;
  /** A meal plan's first day, YYYY-MM-DD (#129). */
  periodStart?: string;
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
  /** Milliseconds; undefined while a new note's server time is pending. */
  updatedAt?: number;
  /** When the note was made; milliseconds. */
  createdAt?: number;
  /** When the note was last settled (left after a change); milliseconds. */
  settledAt?: number;
  /** Who wrote it last: a device id (with a restore or keep suffix), or 'merge'. */
  deviceId?: string;
  /** Whether that was Eric or Claude. */
  updatedBy?: 'user' | 'claude';
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
  /** Takes a field out in a merged write. */
  removeField(): unknown;
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
    ...(recipeSource(data['source']) ? { source: recipeSource(data['source']) } : {}),
    ...(typeof data['servings'] === 'number' ? { servings: data['servings'] } : {}),
    ...(['requested', 'working', 'done', 'failed'].includes(data['importState'] as string)
      ? { importState: data['importState'] as NoteRecord['importState'] }
      : {}),
    ...(typeof data['importError'] === 'string' ? { importError: data['importError'] } : {}),
    ...(typeof data['periodStart'] === 'string' ? { periodStart: data['periodStart'] } : {}),
    ...(data['updatedBy'] === 'claude' || data['updatedBy'] === 'user'
      ? { updatedBy: data['updatedBy'] }
      : {}),
    links: Array.isArray(data['links']) ? data['links'].map(String) : [],
    ...(Array.isArray(data['tags']) && data['tags'].length
      ? { tags: data['tags'].map(String) }
      : {}),
    archived: data['archived'] === true,
    updatedAt: stamp?.toMillis?.(),
    createdAt: (data['createdAt'] as { toMillis?: () => number } | undefined)?.toMillis?.(),
    settledAt: (data['settledAt'] as { toMillis?: () => number } | undefined)?.toMillis?.(),
    ...(typeof data['deviceId'] === 'string' ? { deviceId: data['deviceId'] } : {}),
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
    fields: {
      kind?: 'text' | 'template';
      templateMode?: string;
      fromTemplate?: string;
      instructions?: string;
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
   * A template's Instructions for Claude (#111), its own field, never in
   * the text a note made from it starts with.
   */
  setInstructions(id: string, instructions: string): void {
    if (!this.uid || this.find(id)?.kind !== 'template') return;
    const update = {
      instructions,
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.api.set(this.fb.db, paths.note(this.uid, id), update, true).catch(report);
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
    const title = name.trim();
    if (!this.uid || !title) return undefined;
    const owner = this.names().get(normalizeName(title));
    const stub = owner === undefined ? undefined : this.find(owner);
    const foldable = stub?.kind === 'concept' && !stub.body.trim() && !stub.synonyms?.length;
    if (owner !== undefined && !foldable) return undefined;
    const id = this.newId();
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
    this.api.set(this.fb.db, paths.note(this.uid, id), data, false).catch(report);
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
    return id;
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

  /** A recipe's name (Eric's own), servings or source link (#127). */
  updateRecipe(
    id: string,
    change: { title?: string; servings?: number | null; url?: string },
  ): void {
    if (!this.uid || this.find(id)?.kind !== 'recipe') return;
    const update: Record<string, unknown> = {};
    const title = change.title?.trim();
    if (title && title !== this.find(id)?.title) {
      const owner = this.names().get(normalizeName(title));
      if (owner !== undefined && owner !== id) return;
      update['title'] = title;
      update['titleSource'] = 'user';
    }
    if (change.servings === null) update['servings'] = this.api.removeField();
    else if (change.servings !== undefined && change.servings > 0) {
      update['servings'] = change.servings;
    }
    if (change.url !== undefined) {
      update['source'] = { ...this.find(id)?.source, url: change.url.trim() };
    }
    if (Object.keys(update).length === 0) return;
    const stamp = {
      updatedAt: this.api.serverTime(),
      updatedBy: 'user',
      deviceId: this.deviceId(),
    };
    this.api.set(this.fb.db, paths.note(this.uid, id), { ...update, ...stamp }, true).catch(report);
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
   * device and is made then.
   */
  createConcept(name: string, type: 'other' | 'mood' = 'other'): string {
    const id = conceptId(name);
    if (this.exists(id)) return id;
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
    // A template keeps the name its first line gives it; the context note
    // keeps its own (#113).
    const kind = this.find(id)?.kind;
    if (kind === 'template' || kind === 'context') return;
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
