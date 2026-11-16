import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { AuthService } from '../auth.service';
import { CLAUDE_ACCESS_API } from '../claude/claude-access';
import { KeysService } from '../keys/keys.service';
import { ModulesService } from '../modules/modules.service';
import { NoteKeyService } from '../notes/note-key.service';
import { NotesService } from '../notes/notes.service';
import { type PushState, PushService } from '../push/push.service';
import { type ReminderRecord, RemindersService } from '../reminders/reminders.service';
import { ReaderService } from '../reader/reader.service';
import { FakeAuthService, FakeModules, FakeNotes, FakeReader } from '../testing/fakes';
import { TEST_NOTE_KEY } from '../testing/sealed';
import { SETTINGS_PAGES } from './settings-pages';
import { SETTINGS_ROUTES } from './settings.routes';
import { SettingsShell, pageOf } from './settings-shell';
import { START_ON_KEY, StartOnService } from '../home/start-on';
import { THEME_KEY, ThemeService } from '../theme/theme.service';

const keys = {
  keys: signal<Record<string, { masked: string; broken: boolean }> | undefined>({}),
  save: vi.fn(),
  remove: vi.fn(),
  onArrival: signal(false),
  setOnArrival: vi.fn(),
  arrivalSkip: signal({ templates: [] as string[], tags: [] as string[] }),
  setArrivalSkip: vi.fn(),
  digest: signal({ push: false, hour: 8 }),
  setDigestPush: vi.fn(),
  setDigestHour: vi.fn(),
};

async function open(url: string, signedIn = true) {
  const auth = new FakeAuthService();
  if (signedIn) auth.signInAs('eric@example.com');
  // Every module set by hand: Podcasts follows the Reader's switch
  // until switched itself (#245), so leaving it unset would turn it on.
  const modules = new FakeModules();
  modules.set('projects', true);
  modules.set('kitchen', false);
  modules.set('reader', true);
  modules.set('podcasts', false);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'settings', component: SettingsShell, children: SETTINGS_ROUTES }]),
      { provide: AuthService, useValue: auth },
      {
        provide: PushService,
        useValue: {
          state: signal<PushState>('off'),
          error: signal(''),
          enable: vi.fn(),
          disable: vi.fn(),
          beforeSignOut: vi.fn(),
        },
      },
      { provide: CLAUDE_ACCESS_API, useValue: { revoke: vi.fn() } },
      { provide: NotesService, useValue: new FakeNotes() },
      { provide: ModulesService, useValue: modules },
      { provide: ReaderService, useValue: new FakeReader() },
      {
        provide: RemindersService,
        useValue: { reminders: signal<ReminderRecord[]>([]), add: vi.fn() },
      },
      { provide: KeysService, useValue: keys },
      {
        provide: NoteKeyService,
        useValue: { key: signal(TEST_NOTE_KEY), unconfigured: signal(false) },
      },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  await harness.fixture.whenStable();
  return {
    harness,
    el: harness.routeNativeElement!.closest('app-settings-shell') ?? harness.routeNativeElement!,
    router: TestBed.inject(Router),
  };
}

const h1s = (el: Element) => [...el.querySelectorAll('h1')].map((h) => h.textContent?.trim());

describe('Settings as pages (#290)', () => {
  afterEach(() => {
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(START_ON_KEY);
  });

  it('lists every page as a link with its state, under one h1', async () => {
    const { el, harness } = await open('/settings');
    // The theme and Start on chosen here, not left to their defaults.
    TestBed.inject(ThemeService).set('night', 'light');
    TestBed.inject(StartOnService).set('reader');
    await harness.fixture.whenStable();
    const main = el.querySelector('main')!;
    expect(main.classList.contains('on-page')).toBe(false);
    expect(h1s(el)).toEqual(['Settings']);
    expect(el.querySelector('a[aria-label^="Back to"]')).toBeNull();
    const rows = [...el.querySelectorAll('nav[aria-label="Settings"] li > a')];
    expect(rows.map((a) => a.getAttribute('aria-label'))).toEqual(
      SETTINGS_PAGES.map((p) => p.name),
    );
    expect(rows.map((a) => a.getAttribute('href'))).toEqual(
      SETTINGS_PAGES.map((p) => `/settings/${p.id}`),
    );
    const line = (id: string) => el.querySelector(`#settings-row-${id}`)?.textContent?.trim();
    expect(line('appearance')).toBe('Night Garden, light');
    expect(line('start-on')).toBe('Reader');
    expect(line('modules')).toBe('Projects, Reader on');
    expect(line('account')).toBe('eric@example.com');
    expect(rows[0].getAttribute('aria-describedby')).toBe('settings-row-appearance');
    // No row is the current page on the list itself.
    expect(el.querySelector('[aria-current="page"]')).toBeNull();
  });

  it('names every module that is on, and All off when none is', async () => {
    const { el, harness } = await open('/settings');
    const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
    modules.set('podcasts', true);
    modules.set('projects', false);
    await harness.fixture.whenStable();
    expect(el.querySelector('#settings-row-modules')?.textContent?.trim()).toBe(
      'Reader, Podcasts on',
    );
    modules.set('reader', false);
    modules.set('podcasts', false);
    await harness.fixture.whenStable();
    expect(el.querySelector('#settings-row-modules')?.textContent?.trim()).toBe('All off');
  });

  it('opens each page with its name as the h1 and a way back to Settings', async () => {
    for (const { id, name } of SETTINGS_PAGES) {
      TestBed.resetTestingModule();
      const { el, router } = await open(`/settings/${id}`);
      expect(router.url).toBe(`/settings/${id}`);
      expect(el.querySelector('main')!.classList.contains('on-page')).toBe(true);
      expect(h1s(el)).toEqual([name]);
      const back = el.querySelector('a[aria-label="Back to Settings"]')!;
      expect(back.getAttribute('href')).toBe('/settings');
      expect(el.querySelector(`a[aria-current="page"]`)?.getAttribute('aria-label')).toBe(name);
      expect(el.querySelector('app-settings')).not.toBeNull();
    }
  });

  it('shows each page’s own controls', async () => {
    const { el, harness } = await open('/settings/account');
    const text = () => el.querySelector('.shown')!.textContent!;
    expect(text()).toContain('Sign out');
    expect(text()).toContain('Sealed notes');
    await harness.navigateByUrl('/settings/modules');
    expect(text()).toContain('Show images in articles');
    expect(text()).not.toContain('Sign out');
    await harness.navigateByUrl('/settings/device');
    expect(text()).toContain('Check for updates');
    expect(text()).toContain('Keep up to');
  });

  it('falls back to the list for a page it does not know', async () => {
    const { el, router } = await open('/settings/nowhere');
    expect(router.url).toBe('/settings');
    expect(h1s(el)).toEqual(['Settings']);
  });

  it('sends an old anchor on to its page', async () => {
    for (const [anchor, page] of [
      ['downloads', 'device'],
      ['modules', 'modules'],
      ['kitchen', 'modules'],
      ['sealing', 'account'],
    ]) {
      TestBed.resetTestingModule();
      const { router } = await open(`/settings#${anchor}`);
      expect(router.url).toBe(`/settings/${page}`);
    }
    TestBed.resetTestingModule();
    const { router } = await open('/settings#nothing-here');
    expect(router.url).toBe('/settings#nothing-here');
  });

  it('reads the page from a URL', () => {
    expect(pageOf('/settings')).toBeUndefined();
    expect(pageOf('/settings/device')).toBe('device');
    expect(pageOf('/settings/device?x=1')).toBe('device');
    expect(pageOf('/settings#downloads')).toBeUndefined();
    expect(pageOf('/settings/nowhere')).toBeUndefined();
  });

  it('says Not signed in, on the rows and the pages, when signed out', async () => {
    const { el } = await open('/settings/modules', false);
    expect(el.querySelector('#settings-row-account')?.textContent?.trim()).toBe('Not signed in');
    expect(el.querySelector('#settings-row-modules')).toBeNull();
    expect(el.querySelector('.shown')!.textContent).toContain('Not signed in.');
  });
});
