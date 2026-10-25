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
import { READING_API, type ReadingApi } from '../reading/reading.service';
import { REMINDERS_API, type RemindersApi } from '../reminders/reminders.service';
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
