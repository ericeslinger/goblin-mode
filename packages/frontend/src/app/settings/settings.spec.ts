import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../auth.service';
import { NotesService } from '../notes/notes.service';
import { FakeAuthService, FakeModules, FakeNotes, noteRecord, FakeReader } from '../testing/fakes';
import { ModulesService } from '../modules/modules.service';
import { ReaderService } from '../reader/reader.service';
import { CLAUDE_ACCESS_API } from '../claude/claude-access';
import { type PushState, PushService } from '../push/push.service';
import { type ReminderRecord, RemindersService } from '../reminders/reminders.service';
import { KeysService } from '../keys/keys.service';
import { START_ON_KEY, StartOnService } from '../home/start-on';
import { KEY_SERVICE_MISSING } from '../notes/key-wait-notice';
import { NoteKeyService } from '../notes/note-key.service';
import { TEST_NOTE_KEY } from '../testing/sealed';
import { Settings } from './settings';
import { type SettingsPageId } from './settings-pages';

function fakePush(state: PushState = 'off') {
  return {
    state: signal<PushState>(state),
    error: signal(''),
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    beforeSignOut: vi.fn(async () => undefined),
  };
}

const reminders = { reminders: signal<ReminderRecord[]>([]), add: vi.fn() };

const claude = { consent: vi.fn(), approve: vi.fn(), revoke: vi.fn(async () => 2), go: vi.fn() };

function fakeKeys() {
  return {
    keys: signal<
      Record<string, { masked: string; updatedAt?: number; broken: boolean }> | undefined
    >({}),
    save: vi.fn(async () => ({ masked: 'sk-ant-…0123' })),
    remove: vi.fn(async () => undefined),
    onArrival: signal(false),
    setOnArrival: vi.fn(),
    arrivalSkip: signal<{ templates: string[]; tags: string[] }>({ templates: [], tags: [] }),
    setArrivalSkip: vi.fn(),
    digest: signal({ push: false, hour: 8 }),
    setDigestPush: vi.fn(),
    setDigestHour: vi.fn(),
  };
}
const keys = fakeKeys();

/** This device's note key, as Settings sees it (always sealed, 2026-11-15). */
const noteKeys = {
  key: signal<typeof TEST_NOTE_KEY | undefined>(TEST_NOTE_KEY),
  unconfigured: signal(false),
};

async function render(
  auth: FakeAuthService,
  page: SettingsPageId,
  push = fakePush(),
  notes = new FakeNotes(),
  modules = new FakeModules(),
  reader = new FakeReader(),
) {
  await TestBed.configureTestingModule({
    imports: [Settings],
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: PushService, useValue: push },
      { provide: CLAUDE_ACCESS_API, useValue: claude },
      { provide: NotesService, useValue: notes },
      { provide: ModulesService, useValue: modules },
      { provide: ReaderService, useValue: reader },
      { provide: RemindersService, useValue: reminders },
      { provide: KeysService, useValue: keys },
      { provide: NoteKeyService, useValue: noteKeys },
    ],
  }).compileComponents();
  return show(page);
}

/** One page of Settings (#290), as its route shows it. */
async function show(page: SettingsPageId) {
  const fixture = TestBed.createComponent(Settings);
  fixture.componentRef.setInput('page', page);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('Settings', () => {
  it('shows each section on its own page only (#290)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const modules = new FakeModules();
    modules.set('reader', true);
    // Set by hand: unset, Podcasts would follow the Reader's switch (#245).
    modules.set('podcasts', false);
    const el = await render(auth, 'modules', fakePush(), new FakeNotes(), modules);
    expect(el.querySelector('[aria-label="Modules"]')).not.toBeNull();
    expect(el.textContent).toContain('Keep articles for');
    expect(el.textContent).not.toContain('Sign out');
    expect(el.textContent).not.toContain('Keep up to');
    const device = await show('device');
    expect(device.textContent).toContain('of episodes on this device');
    expect(button(device, 'Check for updates')).toBeDefined();
    expect(device.querySelector('[aria-label="Modules"]')).toBeNull();
    const appearance = await show('appearance');
    expect(appearance.querySelectorAll('input[name="theme"]').length).toBe(5);
    expect(appearance.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('shows who is signed in and the build stamp', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const el = await render(auth, 'account');
    expect(el.textContent).toContain('Signed in as eric@example.com');
    // The build stamp is on This device since #290.
    const device = await show('device');
    expect(device.textContent).toContain('Version');
    expect(device.textContent).toContain('dev');
  });

  it('says so when signed out', async () => {
    const el = await render(new FakeAuthService(), 'account');
    expect(el.textContent).toContain('Not signed in.');
    expect(button(el, 'Sign out')).toBeUndefined();
  });

  it('turns notifications on and off', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const push = fakePush('off');
    const el = await render(auth, 'notifications', push);
    expect(el.textContent).toContain('Reminders are not sent to this device.');
    button(el, 'Turn on notifications')!.click();
    expect(push.enable).toHaveBeenCalled();

    push.state.set('on');
    TestBed.tick();
    expect(el.textContent).toContain('Reminders are sent to this device.');
    button(el, 'Turn off notifications')!.click();
    expect(push.disable).toHaveBeenCalled();
  });

  it('turns this device off before signing out', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const push = fakePush('on');
    const order: string[] = [];
    push.beforeSignOut.mockImplementation(async () => void order.push('push'));
    auth.signOut.mockImplementation(async () => void order.push('auth'));
    const el = await render(auth, 'account', push);
    button(el, 'Sign out')!.click();
    await vi.waitFor(() => expect(order).toEqual(['push', 'auth']));
  });

  it('explains when notifications cannot be turned on', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const el = await render(auth, 'notifications', fakePush('blocked'));
    expect(el.textContent).toContain('Notifications are blocked for this site.');
    expect(button(el, 'Turn on notifications')).toBeUndefined();
  });

  it('shows no notification controls when signed out', async () => {
    const el = await render(new FakeAuthService(), 'notifications');
    expect(el.textContent).not.toContain('Notifications');
    expect(el.textContent).toContain('Not signed in.');
    expect(el.querySelector('button')).toBeNull();
  });

  it('saves a pasted provider key, shows the masked one, and removes it (#144)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    keys.keys.set({});
    const el = await render(auth, 'assistants');
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Anthropic key"]')!;
    input.value = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
    input.closest('form')!.dispatchEvent(new Event('submit'));
    expect(keys.save).toHaveBeenCalledWith(
      'anthropic',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    );
    expect(input.value).toBe('');
    await vi.waitFor(() => {
      TestBed.tick();
      expect(el.textContent).toContain('Anthropic key sk-ant-…0123 saved.');
    });

    keys.keys.set({ anthropic: { masked: 'sk-ant-…0123', updatedAt: Date.now(), broken: false } });
    TestBed.tick();
    expect(el.textContent).toContain('sk-ant-…0123');
    expect(el.querySelector('input[aria-label="Anthropic key"]')).toBeNull();
    button(el, 'Remove')!.click();
    expect(keys.remove).toHaveBeenCalledWith('anthropic');
    await vi.waitFor(() => {
      TestBed.tick();
      expect(el.textContent).toContain('revoke it at Anthropic too');
    });
  });

  it('offers Garden new notes on arrival only with an Anthropic key kept (#214)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    keys.keys.set({});
    const el = await render(auth, 'assistants');
    const toggle = () =>
      [...el.querySelectorAll('label')]
        .find((l) => l.textContent?.includes('Garden new notes on arrival'))
        ?.querySelector('input');
    expect(toggle()).toBeUndefined();
    keys.keys.set({ anthropic: { masked: 'sk-ant-…0123', broken: false } });
    TestBed.tick();
    expect(toggle()!.checked).toBe(false);
    toggle()!.click();
    expect(keys.setOnArrival).toHaveBeenCalledWith(true);
  });

  it('lists templates and takes tags never gardened on arrival (#229)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    keys.keys.set({ anthropic: { masked: 'sk-ant-…0123', broken: false } });
    keys.arrivalSkip.set({ templates: ['t1'], tags: ['private'] });
    keys.setArrivalSkip.mockClear();
    const notes = new FakeNotes();
    notes.signIn([
      { ...noteRecord('t1', 'Shopping list'), kind: 'template', templateMode: 'living' },
      { ...noteRecord('t2', 'Journal'), kind: 'template' },
      noteRecord('n1', 'Not a template'),
    ]);
    const el = await render(auth, 'assistants', fakePush(), notes);
    expect(el.textContent).toContain('Never gardened on arrival');
    expect(el.textContent).toContain('the pantry, the context note and clippings');
    const list = el.querySelector('[aria-labelledby="arrival-skip"]')!;
    const boxes = [...list.querySelectorAll('label')].map((l) => [
      l.textContent!.trim(),
      l.querySelector('input')!.checked,
    ]);
    expect(boxes).toEqual([
      ['Notes made from Journal', false],
      ['Notes made from Shopping list', true],
    ]);
    list.querySelectorAll('input')[0]!.click();
    expect(keys.setArrivalSkip).toHaveBeenLastCalledWith({
      templates: ['t1', 't2'],
      tags: ['private'],
    });
    list.querySelectorAll('input')[1]!.click();
    expect(keys.setArrivalSkip).toHaveBeenLastCalledWith({ templates: [], tags: ['private'] });
    const tags = [...el.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('Notes with these tags'))!
      .querySelector('input')!;
    expect(tags.value).toBe('private');
    tags.value = 'private, journal';
    tags.dispatchEvent(new Event('change'));
    expect(keys.setArrivalSkip).toHaveBeenLastCalledWith({
      templates: ['t1'],
      tags: ['private', 'journal'],
    });
    keys.arrivalSkip.set({ templates: [], tags: [] });
  });

  it('turns the daily digest push on and picks its hour, with no key needed (#237)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    keys.keys.set({});
    keys.setDigestPush.mockClear();
    keys.setDigestHour.mockClear();
    const el = await render(auth, 'assistants');
    expect(el.textContent).toContain('Daily digest');
    const toggle = [...el.querySelectorAll<HTMLInputElement>('input[role="switch"]')].find((i) =>
      i.parentElement?.textContent?.includes('A daily digest by push'),
    )!;
    const hour = el.querySelector<HTMLSelectElement>(
      'select[aria-label="Hour of the daily digest"]',
    )!;
    expect(toggle.checked).toBe(false);
    expect(hour.options).toHaveLength(24);
    expect(hour.selectedIndex).toBe(8);
    toggle.click();
    expect(keys.setDigestPush).toHaveBeenLastCalledWith(true);
    // The hour is changed at once, before the switch shows on anywhere
    // (a late snapshot, #224): it writes only the hour, never the
    // switch's value read back from the signal.
    hour.value = '21';
    hour.dispatchEvent(new Event('change'));
    expect(keys.setDigestHour).toHaveBeenLastCalledWith(21);
    expect(keys.setDigestPush).toHaveBeenCalledTimes(1);
    keys.digest.set({ push: true, hour: 21 });
    TestBed.tick();
    expect(toggle.checked).toBe(true);
    expect(hour.selectedIndex).toBe(21);
    toggle.click();
    expect(keys.setDigestPush).toHaveBeenLastCalledWith(false);
    expect(keys.setDigestHour).toHaveBeenCalledTimes(1);
    keys.digest.set({ push: false, hour: 8 });
  });

  it('shows the connector URL and disconnects Claude', async () => {
    const auth = new FakeAuthService();
    auth.user.set({ email: 'e@x.test', getIdToken: async () => 'id-token' } as never);
    const el = await render(auth, 'assistants');
    expect(el.querySelector('code')?.textContent).toBe(`${location.origin}/mcp`);
    button(el, 'Disconnect all assistants')!.click();
    await vi.waitFor(() => expect(claude.revoke).toHaveBeenCalledWith('id-token'));
    TestBed.tick();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(el.textContent).toContain('Every assistant is disconnected.');
    });
  });

  it('switches modules on and off (#126)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const modules = new FakeModules();
    const el = await render(auth, 'modules', fakePush(), new FakeNotes(), modules);
    const list = el.querySelector('[aria-label="Modules"]')!;
    const projects = list.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(list.textContent).toContain('Projects');
    expect(projects.checked).toBe(true);
    projects.checked = false;
    projects.dispatchEvent(new Event('change'));
    expect(modules.set).toHaveBeenCalledWith('projects', false);
  });

  it('sets the week Habits’ weekly habits count in, only while Habits is on (step 5 of #324)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const modules = new FakeModules();
    const off = await render(auth, 'modules', fakePush(), new FakeNotes(), modules);
    expect(off.querySelector('#habits')).toBeNull();
    modules.set('habits', true);
    TestBed.tick();
    const heading = off.querySelector('#habits')!;
    expect(heading.textContent).toBe('Habits');
    const select = heading.nextElementSibling!.querySelector('select')!;
    expect(select.closest('label')?.textContent).toContain('Weeks start on');
    // Its own name, not Kitchen's (review of #331, 2026-11-22).
    expect(select.getAttribute('aria-label')).toBe('Habits: weeks start on');
    expect(select.value).toBe('Mon');
    select.value = 'Sun';
    select.dispatchEvent(new Event('change'));
    expect(modules.configureHabits).toHaveBeenCalledWith({ weekStart: 'Sun' });
    TestBed.tick();
    expect(select.value).toBe('Sun');
  });

  it('holds Add a feelings journal until the stored modules are read (2026-11-22)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const modules = new FakeModules();
    modules.loaded.set(false);
    const el = await render(auth, 'templates', fakePush(), new FakeNotes(), modules);
    const add = button(el, 'Add a feelings journal') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    modules.loaded.set(true);
    TestBed.tick();
    expect(add.disabled).toBe(false);
  });

  it('says the switches are busy until the stored modules are read (#290)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const modules = new FakeModules();
    modules.loaded.set(false);
    const el = await render(auth, 'modules', fakePush(), new FakeNotes(), modules);
    const list = el.querySelector('[aria-label="Modules"]')!;
    expect(list.getAttribute('aria-busy')).toBe('true');
    modules.loaded.set(true);
    TestBed.tick();
    expect(list.hasAttribute('aria-busy')).toBe(false);
  });

  it('indexes the Reader’s articles for search, and says how many (#175)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const modules = new FakeModules();
    modules.set('reader', true);
    const reader = new FakeReader();
    reader.indexArticles.mockResolvedValueOnce('Indexed 12 articles.');
    const el = await render(auth, 'modules', fakePush(), new FakeNotes(), modules, reader);
    button(el, 'Index articles for search')!.click();
    await new Promise((r) => setTimeout(r));
    TestBed.inject(ApplicationRef).tick();
    expect(reader.indexArticles).toHaveBeenCalledTimes(1);
    const said = [...el.querySelectorAll('[role=status]')].map((p) => p.textContent?.trim());
    expect(said).toContain('Indexed 12 articles.');
  });

  it('lists templates and makes new ones, opening them to write', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const notes = new FakeNotes();
    notes.signIn([
      { ...noteRecord('t1', 'Shopping list'), kind: 'template', templateMode: 'living' },
      { ...noteRecord('t2', 'Journal'), kind: 'template' },
      noteRecord('n1', 'Not a template'),
    ]);
    const el = await render(auth, 'templates', fakePush(), notes);
    const list = el.querySelector('[aria-label="Templates"]')!;
    const rows = [...list.querySelectorAll('li')].map((li) => [
      li.querySelector('a')!.textContent!.trim(),
      li.querySelector('a')!.getAttribute('href'),
      li.querySelector('.muted')!.textContent!.trim(),
    ]);
    expect(rows).toEqual([
      ['Journal', '/n/t2', 'a new note each time'],
      ['Shopping list', '/n/t1', 'one note, reused'],
    ]);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    button(el, 'New living template')!.click();
    expect(notes.create).toHaveBeenCalledWith('new1', 'New template\n', {
      kind: 'template',
      templateMode: 'living',
      instructions: expect.stringContaining('How to fill in'),
    });
    expect(navigate).toHaveBeenCalledWith(['/n', 'new1']);
  });

  it('offers the feelings journal until there is a template with a Moods line (#40)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const notes = new FakeNotes();
    notes.signIn([{ ...noteRecord('t1', 'Journal\nMood: one'), kind: 'template' }]);
    const el = await render(auth, 'templates', fakePush(), notes);
    expect(button(el, 'Add a feelings journal')).toBeDefined();
    // Renamed, it is still the journal.
    notes.notes.set([{ ...noteRecord('t2', 'How I feel\nMoods: '), kind: 'template' }]);
    await TestBed.inject(ApplicationRef).whenStable();
    expect(button(el, 'Add a feelings journal')).toBeUndefined();
  });

  it('checks for updates: without a managed worker it says to reload (2026-11-07)', async () => {
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const el = await render(auth, 'device');
    button(el, 'Check for updates')!.click();
    await vi.waitFor(() => expect(el.textContent).toContain('Updates are not managed here'));
  });

  it('chooses the screen to start on, where it was left until then (#219, #272)', async () => {
    localStorage.removeItem(START_ON_KEY);
    const auth = new FakeAuthService();
    auth.signInAs('eric@example.com');
    const el = await render(auth, 'start-on');
    const radio = (value: string) =>
      el.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
    expect(el.querySelectorAll('[role="radiogroup"] input[type="radio"]')).toHaveLength(6);
    expect(radio('note').checked).toBe(true);
    // Stored as `note`, Where I left off since 2026-11-15 (#272).
    expect(radio('note').closest('label')!.textContent).toContain('Where I left off');
    expect(el.textContent).toContain('Kitchen is off, so this opens Home');
    // Podcasts (#245), off with the Reader until switched on.
    expect(el.textContent).toContain('Podcasts is off, so this opens Home');
    radio('home').click();
    expect(TestBed.inject(StartOnService).choice()).toBe('home');
    expect(JSON.parse(localStorage.getItem(START_ON_KEY)!)).toMatchObject({ choice: 'home' });
    localStorage.removeItem(START_ON_KEY);
  });

  describe('Sealed notes (always sealed, 2026-11-15)', () => {
    async function signedIn() {
      const auth = new FakeAuthService();
      auth.signInAs('eric@example.com');
      const el = await render(auth, 'account');
      return el;
    }
    afterEach(() => {
      noteKeys.key.set(TEST_NOTE_KEY);
      noteKeys.unconfigured.set(false);
    });

    it('says what is true, read only: no switch, no runner', async () => {
      const el = await signedIn();
      const section = el.textContent!;
      expect(section).toContain('The text of your notes is always sealed (encrypted)');
      expect(section).toContain('with Cloudflare');
      expect(section).toContain('Attachments, the links pages came from, and reminder text');
      expect(section).not.toContain('Seal note text');
      expect(el.querySelector('.sealing')).toBeNull();
      expect(button(el, 'Seal everything now')).toBeUndefined();
      expect(section).not.toContain('does not have its note key');
    });

    it('says when this device has no key yet', async () => {
      noteKeys.key.set(undefined);
      const el = await signedIn();
      expect(el.textContent).toContain('This device does not have its note key yet');
    });

    it('says when the key service is not set up, pointing at the README', async () => {
      noteKeys.key.set(undefined);
      noteKeys.unconfigured.set(true);
      const el = await signedIn();
      expect(el.textContent).toContain(KEY_SERVICE_MISSING);
      expect(el.textContent).not.toContain('This device does not have its note key yet');
    });

    it('is not shown signed out', async () => {
      const el = await render(new FakeAuthService(), 'account');
      expect(el.querySelector('#sealing')).toBeNull();
    });
  });
});
