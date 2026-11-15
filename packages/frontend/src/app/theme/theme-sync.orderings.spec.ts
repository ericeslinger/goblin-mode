import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { FakeAuthService, fakeFirebase } from '../testing/fakes';
import { KEPT_SETTINGS_KEY, keepUntilAcknowledged } from './kept-settings';
import { SETTINGS_API, type SettingsApi, ThemeSync } from './theme-sync.service';
import { type ModeChoice, PREFERS_DARK, THEME_KEY, ThemeService } from './theme.service';
import type { ThemeId } from './themes';

type Data = Record<string, unknown> | undefined;
type Next = (data: Data, fromCache: boolean, local: boolean) => void;

const PATH = 'users/u1/settings/app';

/**
 * One settings doc as the Firestore SDK shows it to a listener with
 * metadata changes (#278). A snapshot is made when something changes
 * (the listen, the server's first answer, a write, an acknowledgement,
 * another device's write) and handed over later, as the SDK does a task
 * after making it: `outbox` holds the ones made and not yet heard,
 * `deliver` hands over the oldest. A write made shows in every snapshot
 * after it, `local`, until acknowledged; `ack` acknowledges the oldest,
 * settling its promise before the snapshot it makes is heard. An answer
 * comes a round trip after its write, by when every snapshot made
 * before the write (each handed over a task later) has been heard:
 * `canAck` says so.
 */
class SdkDoc implements SettingsApi {
  server: Data;
  cache: Data;
  heard = false;
  readonly pending: { data: Record<string, unknown>; done: () => void; made: number }[] = [];
  readonly outbox: { data: Data; fromCache: boolean; local: boolean; made: number }[] = [];
  private next?: Next;
  private made = 0;

  constructor(cached: Data) {
    this.server = this.cache = cached;
  }

  listen = (_db: unknown, _path: string, next: Next) => {
    this.next = next;
    this.make();
    return () => (this.next = undefined);
  };
  set = (_db: unknown, _path: string, data: Record<string, unknown>) =>
    new Promise<void>((done) => {
      this.pending.push({ data: { ...data }, done, made: this.made });
      this.make();
    });
  now = () => 'SERVER_TIME';

  canAck(): boolean {
    const write = this.pending[0];
    return !!write && (this.outbox[0]?.made ?? Infinity) > write.made;
  }
  /** The server's first answer to the listen. */
  answer(): void {
    this.heard = true;
    this.make();
  }
  ack(): void {
    const write = this.pending.shift()!;
    this.server = this.cache = write.data;
    write.done();
    this.make();
  }
  /** Another device's write reaching the server. */
  remote(data: Record<string, unknown>): void {
    this.server = data;
    if (this.heard) this.make();
  }
  deliver(): void {
    const snap = this.outbox.shift()!;
    this.next?.(snap.data, snap.fromCache, snap.local);
  }

  private make(): void {
    if (!this.next) return;
    const top = this.pending.at(-1)?.data;
    const data = top ?? (this.heard ? this.server : this.cache);
    this.outbox.push({
      data: data && { ...data },
      fromCache: !this.heard,
      local: this.pending.length > 0,
      made: ++this.made,
    });
  }
}

interface Page {
  doc: SdkDoc;
  auth: FakeAuthService;
  theme: ThemeService;
}

/**
 * A page just loaded: this device's choice in `goblin.theme`, the cached
 * doc, and a write left unacknowledged by the load before, if any.
 */
function load(
  stored: { theme: ThemeId; mode: ModeChoice },
  cached: Data,
  left?: Record<string, unknown>,
): Page {
  TestBed.resetTestingModule();
  localStorage.clear();
  localStorage.setItem(THEME_KEY, JSON.stringify(stored));
  if (left) {
    localStorage.setItem(
      `${KEPT_SETTINGS_KEY}.${PATH}`,
      JSON.stringify({ seq: 1, merge: false, data: left }),
    );
  }
  const doc = new SdkDoc(cached);
  const auth = new FakeAuthService();
  // Sign-in is still being restored as the page loads.
  auth.user.set(undefined);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: auth },
      // As in production: the SDK's doc, kept until acknowledged (#224).
      { provide: SETTINGS_API, useValue: keepUntilAcknowledged(doc, localStorage) },
      { provide: PREFERS_DARK, useValue: null },
    ],
  });
  TestBed.inject(ThemeSync);
  const theme = TestBed.inject(ThemeService);
  TestBed.tick();
  return { doc, auth, theme };
}

/** Lets settled writes run their handlers and effects run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  TestBed.tick();
}

type Step = 'sign in' | 'answer' | 'tap theme' | 'tap mode' | 'ack' | 'deliver';

interface Scenario {
  stored: { theme: ThemeId; mode: ModeChoice };
  cached: Data;
  left?: Record<string, unknown>;
  /** The theme tapped, or undefined when it is already the one shown. */
  tapTheme?: ThemeId;
  tapMode: ModeChoice;
}

/**
 * Runs one ordering: `choices` picks among the steps possible at each
 * point (the rest take the first). Returns what went wrong, if
 * anything, and how many steps were possible at each point, so every
 * ordering can be walked.
 */
async function run(
  s: Scenario,
  choices: number[],
): Promise<{ widths: number[]; path: Step[]; wrong?: string }> {
  const { doc, auth, theme } = load(s.stored, s.cached, s.left);
  const want = { theme: s.tapTheme ?? s.stored.theme, mode: s.tapMode };
  const done = new Set<Step>(s.tapTheme ? [] : ['tap theme']);
  const widths: number[] = [];
  const path: Step[] = [];
  for (;;) {
    const can: Step[] = [];
    if (!done.has('sign in')) can.push('sign in');
    if (done.has('sign in') && !done.has('answer')) can.push('answer');
    if (!done.has('tap theme')) can.push('tap theme');
    if (done.has('tap theme') && !done.has('tap mode')) can.push('tap mode');
    if (doc.canAck()) can.push('ack');
    if (doc.outbox.length) can.push('deliver');
    if (!can.length) break;
    const pick = choices[widths.length] ?? 0;
    widths.push(can.length);
    const step = can[pick];
    path.push(step);
    done.add(step);
    if (step === 'sign in') auth.user.set({ uid: 'u1' } as User);
    if (step === 'answer') doc.answer();
    if (step === 'tap theme') theme.set(s.tapTheme!);
    if (step === 'tap mode') theme.set(theme.theme(), s.tapMode);
    if (step === 'ack') doc.ack();
    if (step === 'deliver') doc.deliver();
    await flush();
    if (done.has('tap theme') && theme.theme() !== want.theme) {
      return { widths, path, wrong: `theme undone to ${theme.theme()}` };
    }
    if (done.has('tap mode') && theme.mode() !== want.mode) {
      return { widths, path, wrong: `mode undone to ${theme.mode()}` };
    }
  }
  const server = { theme: doc.server?.['theme'], mode: doc.server?.['mode'] };
  if (server.theme !== want.theme || server.mode !== want.mode) {
    return { widths, path, wrong: `the doc kept ${server.theme} ${server.mode}` };
  }
  if (localStorage.getItem(THEME_KEY) !== JSON.stringify(want)) {
    return { widths, path, wrong: 'this device kept another choice' };
  }
  return { widths, path };
}

/** Every ordering of the scenario's steps; the first that goes wrong, if any. */
async function everyOrdering(s: Scenario): Promise<{ runs: number; wrong?: string }> {
  let choices: number[] = [];
  let runs = 0;
  for (;;) {
    const result = await run(s, choices);
    runs++;
    if (result.wrong) return { runs, wrong: `${result.wrong}: ${result.path.join(', ')}` };
    // The next ordering: the last point with a step left untried.
    const taken = result.widths.map((_, i) => choices[i] ?? 0);
    let i = taken.length - 1;
    while (i >= 0 && taken[i] + 1 >= result.widths[i]) i--;
    if (i < 0) return { runs };
    choices = [...taken.slice(0, i), taken[i] + 1];
  }
}

describe('ThemeSync on a page just loaded, every ordering (#278)', () => {
  afterEach(() => localStorage.clear());

  it('a mode tapped is never undone by the cached doc heard just after it', async () => {
    // The journey's failing step, Dark after Light: the theme is already
    // the one shown, so only the mode is tapped.
    const { doc, auth, theme } = load(
      { theme: 'night', mode: 'light' },
      { theme: 'night', mode: 'light' },
    );
    auth.user.set({ uid: 'u1' } as User);
    await flush();
    // The cached doc's snapshot is made, not yet heard; then the tap.
    theme.set('night', 'dark');
    await flush();
    doc.deliver();
    await flush();
    expect(theme.mode()).toBe('dark');
    while (doc.pending.length || doc.outbox.length) {
      while (doc.outbox.length) doc.deliver();
      if (doc.pending.length) doc.ack();
      await flush();
    }
    expect(theme.mode()).toBe('dark');
    expect(doc.server).toMatchObject({ theme: 'night', mode: 'dark' });
  });

  it('a theme tapped is not undone and then written away by the mode tapped next', async () => {
    const { doc, auth, theme } = load(
      { theme: 'herbarium', mode: 'dark' },
      { theme: 'herbarium', mode: 'dark' },
    );
    auth.user.set({ uid: 'u1' } as User);
    await flush();
    theme.set('night');
    await flush();
    // The cached doc, made before the tap, heard after it.
    doc.deliver();
    await flush();
    expect(theme.theme()).toBe('night');
    theme.set(theme.theme(), 'light');
    await flush();
    while (doc.pending.length || doc.outbox.length) {
      while (doc.outbox.length) doc.deliver();
      if (doc.pending.length) doc.ack();
      await flush();
    }
    // Without the fix the mode's write carried the undone theme: lost.
    expect(doc.server).toMatchObject({ theme: 'night', mode: 'light' });
    expect(theme.theme()).toBe('night');
  });

  it('a mode tapped is not undone by the theme write’s answer heard after it', async () => {
    const { doc, auth, theme } = load(
      { theme: 'herbarium', mode: 'dark' },
      { theme: 'herbarium', mode: 'dark' },
    );
    auth.user.set({ uid: 'u1' } as User);
    await flush();
    doc.deliver();
    doc.answer();
    doc.deliver();
    await flush();
    theme.set('night');
    await flush();
    // Acknowledged before the mode is tapped; its snapshot heard after.
    doc.ack();
    await flush();
    theme.set('night', 'light');
    await flush();
    while (doc.outbox.length) doc.deliver();
    await flush();
    expect(theme.mode()).toBe('light');
  });

  it('theme then mode, in every ordering of snapshots, writes and answers', async () => {
    const result = await everyOrdering({
      stored: { theme: 'herbarium', mode: 'dark' },
      cached: { theme: 'herbarium', mode: 'dark', updatedAt: 'x' },
      tapTheme: 'night',
      tapMode: 'light',
    });
    expect(result.wrong).toBeUndefined();
    expect(result.runs).toBeGreaterThan(100);
  }, 120_000);

  it('the mode alone, the theme already shown, in every ordering', async () => {
    const result = await everyOrdering({
      stored: { theme: 'night', mode: 'light' },
      cached: { theme: 'night', mode: 'light', updatedAt: 'x' },
      tapMode: 'dark',
    });
    expect(result.wrong).toBeUndefined();
  }, 120_000);

  it('after a quick reload, the kept choice and a new tap, in every ordering (#224)', async () => {
    // The load before chose Bog Goblin, light, and reloaded before the
    // cache took it: the cached doc is older, the write is kept.
    const result = await everyOrdering({
      stored: { theme: 'bog', mode: 'light' },
      cached: { theme: 'herbarium', mode: 'dark', updatedAt: 'x' },
      left: { theme: 'bog', mode: 'light', updatedAt: { 'goblin.serverTime': true } },
      tapMode: 'dark',
    });
    expect(result.wrong).toBeUndefined();
  }, 120_000);

  it('a quick reload alone keeps the choice over the older cached doc (#224)', async () => {
    const { doc, auth, theme } = load(
      { theme: 'bog', mode: 'light' },
      { theme: 'herbarium', mode: 'dark' },
      { theme: 'bog', mode: 'light', updatedAt: { 'goblin.serverTime': true } },
    );
    auth.user.set({ uid: 'u1' } as User);
    await flush();
    doc.answer();
    while (doc.pending.length || doc.outbox.length) {
      while (doc.outbox.length) doc.deliver();
      if (doc.pending.length) doc.ack();
      await flush();
    }
    expect(theme.theme()).toBe('bog');
    expect(theme.mode()).toBe('light');
    expect(doc.server).toMatchObject({ theme: 'bog', mode: 'light' });
    expect(localStorage.getItem(`${KEPT_SETTINGS_KEY}.${PATH}`)).toBeNull();
  });

  it('a choice made on another device arrives, once this device’s writes are in', async () => {
    const { doc, auth, theme } = load(
      { theme: 'herbarium', mode: 'dark' },
      { theme: 'herbarium', mode: 'dark' },
    );
    auth.user.set({ uid: 'u1' } as User);
    await flush();
    doc.answer();
    while (doc.outbox.length) doc.deliver();
    await flush();
    // Idle: adopted as it is heard.
    doc.remote({ theme: 'pixel', mode: 'dark' });
    doc.deliver();
    await flush();
    expect(theme.theme()).toBe('pixel');

    // Heard while a write of this device's is on its way, and later
    // than it on the server: shown once the write is acknowledged.
    theme.set('moss');
    await flush();
    doc.ack();
    await flush();
    doc.remote({ theme: 'bog', mode: 'light' });
    while (doc.outbox.length) doc.deliver();
    await flush();
    expect(theme.theme()).toBe('bog');
    expect(theme.mode()).toBe('light');
  });
});
