// Spec-support helpers; never imported from production code.
import { computed, signal } from '@angular/core';
import {
  type KitchenConfig,
  type ModuleId,
  conceptId,
  kitchenConfig,
  madeHistory,
  moduleOn,
  nameIndex,
  planId,
} from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { RunsService } from '../agent/runs.service';
import { FIREBASE, type FirebaseHandles } from '../firebase';
import { KeysService } from '../keys/keys.service';
import { ModulesService } from '../modules/modules.service';
import { NOW, TIME_ZONE } from '../platform/platform';
import { ITEMS_API, type ItemRecord, type ItemsApi, type Shelf } from '../reader/items.service';
import type {
  ConnectionInfo,
  DownloadProgress,
  DownloadRecord,
  DownloadsApi,
  EpisodeCache,
} from '../reader/downloads.service';
import type { AudioLike } from '../reader/player.service';
import { READER_API, type ReaderApi, type SearchOutcome } from '../reader/reader.service';
import { READING_API, type ReadingApi } from '../reading/reading.service';
import { REMINDERS_API, type RemindersApi } from '../reminders/reminders.service';
import { SETTINGS_API, type SettingsApi } from '../theme/theme-sync.service';
import type { ProposalRecord } from '../claude/proposals.service';
import type { NoteRecord, NotesService } from '../notes/notes.service';
import type { Transcription } from '../attachments/attachments.service';

export function fakeFirebase(usingEmulators: boolean): FirebaseHandles {
  return {
    app: {},
    auth: {},
    db: {},
    storage: {},
    functions: {},
    usingEmulators,
  } as unknown as FirebaseHandles;
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
  save = vi.fn(
    (id: string, _body: string, _opts?: { restore?: boolean }) => void this.written.add(id),
  );
  remove = vi.fn((id: string) => void this.written.delete(id));
  settle = vi.fn((_id: string, _opts?: { edited?: boolean }) => undefined);
  readonly names = computed(() => nameIndex(this.notes()));
  readonly made = computed(() =>
    madeHistory(this.notes().filter((n) => n.kind === 'mealplan' && !n.archived)),
  );
  ensurePlan = vi.fn((start: string, _config: KitchenConfig) => planId(start));
  addRecipeNote = vi.fn((_id: string, _line: string) => undefined);
  ensurePantry = vi.fn(() => {
    this.written.add('pantry');
    return 'pantry';
  });
  plantConcepts = vi.fn((_body: string) => undefined);
  createConcept = vi.fn((name: string, _type?: 'other' | 'mood') => conceptId(name));
  createItem = vi.fn((_parent: string, name: string, _stage?: string) => conceptId(name));
  updateConcept = vi.fn(
    (_id: string, _change: Parameters<NotesService['updateConcept']>[1]) => [] as string[],
  );
  create = vi.fn(
    (
      id: string,
      body: string,
      fields: { kind?: string; templateMode?: string; fromTemplate?: string } = {},
    ) => {
      this.written.add(id);
      this.notes.update((list) => [{ ...noteRecord(id, body), ...fields }, ...list]);
    },
  );
  setTemplateMode = vi.fn((_id: string, _mode: 'living' | 'entry') => undefined);
  createRecipe = vi.fn((name: string) =>
    this.names().has(name.trim().toLowerCase()) ? undefined : `new${++this.n}`,
  );
  updateRecipe = vi.fn(
    (_id: string, _change: Parameters<NotesService['updateRecipe']>[1]) => undefined,
  );
  setInstructions = vi.fn((_id: string, _text: string) => undefined);
  sendToAssistant = vi.fn((_id: string, _ask: string) => undefined);
  clip = vi.fn((_body: string, _title: string, _source: { url?: string; feedItemId: string }) => {
    const id = `clip${++this.n}`;
    this.written.add(id);
    return id;
  });
  unsend = vi.fn((_id: string) => undefined);
  makeContext = vi.fn(async () => undefined);
  newId = () => `new${++this.n}`;
  deviceId = () => 'here';
  find = (id: string) => this.notes().find((x) => x.id === id);
  exists = (id: string) => this.written.has(id) || !!this.find(id);

  signIn(list: NoteRecord[] = []): void {
    this.notes.set(list);
    this.loaded.set(true);
  }
}

export function noteRecord(id: string, body: string): NoteRecord {
  return {
    id,
    body,
    title: body.split('\n')[0],
    titleSource: 'words',
    kind: 'text',
    links: [],
    archived: false,
  };
}

/** A stand-in Firestore seam for RemindersService; `push` is a snapshot. */
export class FakeRemindersApi implements RemindersApi {
  private next: (docs: { id: string; data: Record<string, unknown> }[]) => void = () => undefined;
  listen = vi.fn(
    (
      _db: unknown,
      _path: string,
      next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    ) => {
      this.next = next;
      return vi.fn();
    },
  );
  set = vi.fn((_db: unknown, _path: string, _data: Record<string, unknown>, _merge: boolean) =>
    Promise.resolve(),
  );
  remove = () => 'DELETE';
  timestamp = (ms: number) => ({ toMillis: () => ms });

  push(docs: { id: string; data: Record<string, unknown> }[]): void {
    this.next(docs);
  }
}

/** A stored reminder as a snapshot doc; times in milliseconds. */
export function reminderDoc(
  id: string,
  fields: { text: string; dueAt?: number; snoozedUntil?: number; [k: string]: unknown },
): { id: string; data: Record<string, unknown> } {
  const stamp = (ms?: number) => (ms === undefined ? undefined : { toMillis: () => ms });
  const { dueAt, snoozedUntil, ...rest } = fields;
  const data: Record<string, unknown> = { status: 'open', createdBy: 'user', ...rest };
  if (dueAt !== undefined) data['dueAt'] = stamp(dueAt);
  if (snoozedUntil !== undefined) data['snoozedUntil'] = stamp(snoozedUntil);
  return { id, data };
}

/**
 * Providers for the real RemindersService over a fake seam, with the
 * clock and time zone fixed. Auth is provided by each spec.
 */
/** A stand-in ModulesService: every module at its default until set (#126). */
export class FakeModules {
  private readonly stored = signal<Partial<Record<ModuleId, boolean>>>({});
  readonly projects = computed(() => this.on('projects'));
  readonly kitchen = computed(() => this.on('kitchen'));
  readonly reader = computed(() => this.on('reader'));
  readonly config = signal<Partial<KitchenConfig>>({});
  readonly kitchenConfig = computed(() => kitchenConfig(this.config()));
  readonly loaded = signal(true);
  configureKitchen = vi.fn((change: Partial<KitchenConfig>) =>
    this.config.update((c) => ({ ...c, ...change })),
  );
  on(id: ModuleId): boolean {
    return this.stored()[id] ?? moduleOn(undefined, id);
  }
  set = vi.fn((id: ModuleId, enabled: boolean) =>
    this.stored.update((s) => ({ ...s, [id]: enabled })),
  );
}

/** A stand-in KeysService: no keys kept until set (#144). */
export class FakeKeys {
  readonly keys = signal<Record<string, { masked: string; broken: boolean }> | undefined>({});
  save = vi.fn(async (_provider: string, _key: string) => ({ masked: 'sk-ant-…0123' }));
  remove = vi.fn(async (_provider: string) => undefined);
}

/** A stand-in RunsService: starts nothing, watches nothing (#144 step 3). */
export class FakeRuns {
  start = vi.fn(async (_noteId: string) => ({ runId: 'r1' }));
  watch = vi.fn((_runId: string, _next: (run: unknown) => void) => () => undefined);
}

export function remindersTestProviders(api: FakeRemindersApi, now: () => number) {
  return [
    { provide: ModulesService, useValue: new FakeModules() },
    { provide: KeysService, useValue: new FakeKeys() },
    { provide: RunsService, useValue: new FakeRuns() },
    { provide: FIREBASE, useValue: fakeFirebase(true) },
    { provide: READING_API, useValue: new FakeReadingApi() },
    { provide: READER_API, useValue: new FakeReaderApi() },
    { provide: ITEMS_API, useValue: new FakeItemsApi() },
    { provide: SETTINGS_API, useValue: new FakeSettingsApi() },
    { provide: REMINDERS_API, useValue: api },
    { provide: NOW, useValue: now },
    { provide: TIME_ZONE, useValue: 'America/New_York' },
  ];
}

/** A stand-in Firestore seam for ReadingService; `push` is a snapshot. */
export class FakeReadingApi implements ReadingApi {
  private next: (docs: { id: string; data: Record<string, unknown> }[]) => void = () => undefined;
  listen = vi.fn(
    (
      _db: unknown,
      _path: string,
      next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    ) => {
      this.next = next;
      return vi.fn();
    },
  );
  set = vi.fn((_db: unknown, _path: string, _data: Record<string, unknown>, _merge: boolean) =>
    Promise.resolve(),
  );
  serverTime = () => 'SERVER_TIME';

  push(docs: { id: string; data: Record<string, unknown> }[]): void {
    this.next(docs);
  }
}

/** A stand-in Firestore seam for ReaderService (#159); `push` is a snapshot. */
export class FakeReaderApi implements ReaderApi {
  private next: (docs: { id: string; data: Record<string, unknown> }[]) => void = () => undefined;
  listen = vi.fn(
    (
      _db: unknown,
      _path: string,
      next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    ) => {
      this.next = next;
      return vi.fn();
    },
  );
  set = vi.fn((_db: unknown, _path: string, _data: Record<string, unknown>, _merge: boolean) =>
    Promise.resolve(),
  );
  remove = vi.fn((_db: unknown, _path: string) => Promise.resolve());
  serverTime = () => 'SERVER_TIME';
  clear = () => 'CLEAR';
  refresh = vi.fn(async () => ({ fetched: 2, added: 5, failed: 0, skipped: 0 }));
  applyRetention = vi.fn(async (_keepMonths: number | null) => ({ touched: 7 }));
  sweep = vi.fn(async () => ({ removed: 3 }));
  discoverFeeds = vi.fn(async (_url: string) => [
    { url: 'https://site.test/posts.xml', title: 'Posts' },
    { url: 'https://site.test/games.atom', title: 'Dice' },
  ]);
  searchArticles = vi.fn(async (_q: string, _limit: number): Promise<SearchOutcome> => ({
    items: [],
    truncated: false,
  }));
  indexArticles = vi.fn(async () => ({ indexed: 4 }));

  push(docs: { id: string; data: Record<string, unknown> }[]): void {
    this.next(docs);
  }
}

/** A stand-in for the settings-doc seam (theme, modules, reader settings). */
export class FakeSettingsApi implements SettingsApi {
  private next: (
    data: Record<string, unknown> | undefined,
    fromCache: boolean,
    local: boolean,
  ) => void = () => undefined;
  readonly stop = vi.fn();
  listen = vi.fn(
    (
      _db: unknown,
      _path: string,
      next: (data: Record<string, unknown> | undefined, fromCache: boolean, local: boolean) => void,
    ) => {
      this.next = next;
      return this.stop;
    },
  );
  set = vi.fn((_db: unknown, _path: string, _data: Record<string, unknown>) => Promise.resolve());
  now = () => 'SERVER_TIME';

  push(data: Record<string, unknown> | undefined, fromCache = false, local = false): void {
    this.next(data, fromCache, local);
  }
}

/** A stand-in Firestore seam for ItemsService (#162); `push` is one shelf's snapshot. */
export class FakeItemsApi implements ItemsApi {
  private readonly nexts = new Map<
    Shelf,
    (docs: { id: string; data: Record<string, unknown> }[]) => void
  >();
  listen = vi.fn(
    (
      _db: unknown,
      _path: string,
      shelf: Shelf,
      next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    ) => {
      this.nexts.set(shelf, next);
      return vi.fn();
    },
  );
  set = vi.fn((_db: unknown, _path: string, _data: Record<string, unknown>) => Promise.resolve());
  setMany = vi.fn((_db: unknown, _writes: { path: string; data: Record<string, unknown> }[]) =>
    Promise.resolve(),
  );
  serverTime = () => 'SERVER_TIME';
  timestamp = (ms: number) => `TIME:${ms}`;
  clear = () => 'CLEAR';
  fetchArticle = vi.fn(async (_itemId: string) => ({ state: 'done' }));
  private readonly ones = new Map<string, (data: Record<string, unknown> | undefined) => void>();
  readonly stopOne = vi.fn();
  listenOne = vi.fn(
    (_db: unknown, path: string, next: (data: Record<string, unknown> | undefined) => void) => {
      this.ones.set(path, next);
      return this.stopOne;
    },
  );

  push(shelf: Shelf, docs: { id: string; data: Record<string, unknown> }[]): void {
    this.nexts.get(shelf)?.(docs);
  }

  /** One article's document, for a listener `listenOne` started (#175). */
  pushOne(path: string, data: Record<string, unknown> | undefined): void {
    this.ones.get(path)?.(data);
  }
}

/** A stand-in for the player's audio element (#179): set fields, then `emit` its events. */
export class FakeAudio implements AudioLike {
  src = '';
  preload = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  ended = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  private readonly listeners = new Map<string, (() => void)[]>();
  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
    this.emit('play');
  });
  pause = vi.fn(() => {
    if (this.paused) return;
    this.paused = true;
    this.emit('pause');
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
  });
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string): void {
    for (const l of this.listeners.get(type) ?? []) l();
  }
  /** The metadata landing: its length known. */
  meta(duration: number): void {
    this.duration = duration;
    this.emit('loadedmetadata');
  }
  /** Playing on to a time. */
  tick(at: number): void {
    this.currentTime = at;
    this.emit('timeupdate');
  }
  /** Played out. */
  end(): void {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.emit('pause');
    this.emit('ended');
  }
}

/** A Cache Storage cache in memory (#180): bodies read in full on put, as the browser does. */
export class FakeEpisodeCache implements EpisodeCache {
  readonly stored = new Map<string, { body: Uint8Array; headers: Headers }>();
  keys = vi.fn(async () => [...this.stored.keys()].map((url) => ({ url })));
  match = vi.fn(async (url: string) => {
    const hit = this.stored.get(url);
    return hit ? new Response(hit.body.slice(), { headers: hit.headers }) : undefined;
  });
  put = vi.fn(async (url: string, res: Response) => {
    const body = new Uint8Array(await res.arrayBuffer());
    this.stored.set(url, { body, headers: new Headers(res.headers) });
  });
  delete = vi.fn(async (url: string) => this.stored.delete(url));
}

/**
 * The downloads' browser seam (#180): the memory cache, a fetch that
 * answers `bytes` of audio for any link (or `answer`'s response), and
 * the connection the browser reports.
 */
export class FakeDownloadsApi implements DownloadsApi {
  readonly cache = new FakeEpisodeCache();
  conn: ConnectionInfo | undefined = undefined;
  /** Bytes the fake fetch answers per link, by enclosure link; 1000 when unlisted. */
  sizes: Record<string, number> = {};
  /** Whether the answer states its length. */
  stateLength = true;
  open = vi.fn(async () => this.cache);
  fetch = vi.fn(async (url: string, _init: RequestInit) => {
    const link = decodeURIComponent(url.split('url=')[1] ?? '');
    const n = this.sizes[link] ?? 1000;
    return new Response(new Uint8Array(n), {
      headers: {
        'content-type': 'audio/mpeg',
        ...(this.stateLength ? { 'content-length': String(n) } : {}),
      },
    });
  });
  connection = () => this.conn;
}

/**
 * A stand-in for DownloadsService (#180): nothing downloaded until
 * `download` is called, which keeps it at once; plays the enclosure's
 * link otherwise, as the real one does.
 */
export class FakeDownloads {
  readonly records = signal<DownloadRecord[]>([]);
  readonly available = signal(true);
  readonly loaded = signal(true);
  readonly progress = signal<Record<string, DownloadProgress>>({});
  readonly list = computed(() => this.records());
  readonly total = computed(() => this.records().reduce((sum, r) => sum + r.bytes, 0));
  has = (id: string) => this.records().some((r) => r.id === id);
  record = (id: string) => this.records().find((r) => r.id === id);
  source = (item: ItemRecord) =>
    this.has(item.id)
      ? `/api/episode?url=${encodeURIComponent(item.enclosure?.url ?? '')}`
      : item.enclosure?.url;
  mayDownload = () => true;
  download = vi.fn(async (item: ItemRecord) => {
    this.records.update((l) => [
      ...l,
      {
        id: item.id,
        feedId: item.feedId,
        title: item.title,
        published: item.published,
        url: item.enclosure?.url ?? '',
        bytes: 1000,
        auto: false,
      },
    ]);
    return undefined as string | undefined;
  });
  remove = vi.fn(async (id: string) => this.records.update((l) => l.filter((r) => r.id !== id)));
  forgetIfGone = vi.fn(async (_id: string) => undefined);
  settled = async () => undefined;
}

/** A stand-in for ReaderService (#159): no feeds, images on. */
export class FakeReader {
  readonly feeds = signal<never[]>([]);
  readonly loaded = signal(true);
  readonly folders = computed(() => [] as { name: string; feeds: never[] }[]);
  readonly folderNames = computed(() => [] as string[]);
  readonly images = signal(true);
  readonly keepMonths = signal<number | undefined>(undefined);
  readonly readOnScroll = signal(false);
  readonly seenAt = signal<Record<string, number>>({});
  readonly settingsLoaded = signal(true);
  markSeen = vi.fn((folder: string, at: number) =>
    this.seenAt.update((s) => ({ ...s, [folder]: at })),
  );
  setImages = vi.fn((images: boolean) => this.images.set(images));
  setReadOnScroll = vi.fn((v: boolean) => this.readOnScroll.set(v));
  setKeepMonths = vi.fn(async (months: number | undefined) => {
    this.keepMonths.set(months);
    return 'Keeping everything; 0 articles will no longer expire.';
  });
  sweep = vi.fn(async () => 'Removed 0 old unread articles.');
  refresh = vi.fn(async () => 'Looked at 0 feeds: 0 new articles.');
  indexArticles = vi.fn(async () => 'Indexed 0 articles.');
  search = vi.fn(
    async (_text: string) => ({ items: [], truncated: false }) as SearchOutcome | string,
  );
}

/** A stand-in for ItemsService (#162): nothing unread. */
export class FakeItems {
  readonly loaded = signal(true);
  readonly items = signal<never[]>([]);
  readonly unreadCounts = signal<Record<string, number>>({ all: 0, saved: 0 });
  readonly newSince = signal<{ folder: string; count: number }[]>([]);
  markSeen = vi.fn((_folder: string) => undefined);
  inShelf = () => [];
  find = () => undefined;
  setRead = vi.fn();
  setSaved = vi.fn();
  markAllRead = vi.fn(() => 0);
  setReadMany = vi.fn((ids: string[], _read: boolean) => ids.length);
  fileInGarden = vi.fn(() => 'clip1');
  readerMode = vi.fn(async () => undefined);
  open = vi.fn((_id: string) => undefined);
  age = () => 'just now';
}

/** A stand-in for ProposalsService: set `list`, watch accept and dismiss. */
export class FakeProposals {
  readonly list = signal<ProposalRecord[]>([]);
  readonly loaded = signal(true);
  readonly shown = computed(() => this.list());
  readonly open = computed(() => this.list().filter((p) => p.status === 'open').length);
  accept = vi.fn((_id: string) => undefined);
  dismiss = vi.fn((_id: string) => undefined);
}

/** A stand-in for AttachmentsService: nothing queued, no files. */
export class FakeAttachments {
  readonly waiting = signal<ReadonlySet<string>>(new Set());
  readonly arrived = signal(0);
  readonly urls = new Map<string, string>();
  resolve = (id: string) => this.urls.get(id);
  full = vi.fn(async (id: string): Promise<string | undefined> => this.urls.get(id));
  readonly struggling = signal(false);
  readonly inMemory = signal(false);
  inspect = vi.fn(
    async (
      _file: File,
      _want?: 'photo' | 'pdf',
    ): Promise<{ type: string } | { error: string }> => ({
      type: 'image/png',
    }),
  );
  newId = () => 'img1';
  attach = vi.fn(
    async (_file: File, _id: string, _type: string, _noteId?: string): Promise<void> => undefined,
  );
  transcribe = vi.fn((_id: string, _update: (state: Transcription) => void) => () => undefined);
}
