import { Component, HostListener } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { NewNoteService } from '../home/new-note';
import { PLACES, type PlaceId } from '../home/places';
import { ModulesService } from '../modules/modules.service';
import { FakeAuthService, FakeModules } from '../testing/fakes';
import {
  APPLE,
  GO_KEYS,
  GO_WAIT_MS,
  PLACE_ORDER,
  applePlatform,
  filterCommands,
  placeForKey,
} from './shortcuts';
import { ShortcutsService } from './shortcuts.service';

@Component({ template: '' })
class Blank {}

/** Browse as far as `/` cares: its Search notes box. */
@Component({
  selector: 'app-browse',
  template: '<input type="search" aria-label="Search notes" />',
})
class BrowseStub {}

/** A screen with the Reader's own keys: a document listener, as reader-article.ts has. */
@Component({ template: '<p>an article</p>' })
class ReaderStub {
  static heard: string[] = [];
  @HostListener('document:keydown', ['$event'])
  protected keys(event: KeyboardEvent): void {
    ReaderStub.heard.push(event.key);
    if (event.key === 's') event.preventDefault();
  }
}

/** A keydown as the browser sends it, from `target` (the page itself by default). */
function press(
  key: string,
  init: KeyboardEventInit & { keyCode?: number } = {},
  target: EventTarget = document.body,
): KeyboardEvent {
  const { keyCode, ...rest } = init;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...rest });
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  target.dispatchEvent(event);
  return event;
}

interface Setup {
  url?: string;
  kitchen?: boolean;
  signedIn?: boolean;
  /** An Apple platform's keys; the test browser's own otherwise (not Apple). */
  apple?: boolean;
}

async function setup({ url = '/home', kitchen = false, signedIn = true, apple }: Setup = {}) {
  const auth = new FakeAuthService();
  if (signedIn) auth.user.set({ uid: 'u1', email: 'eric@example.com' } as User);
  const modules = new FakeModules();
  if (kitchen) modules.set('kitchen', true);
  const newNote = { start: vi.fn(() => Promise.resolve()) };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'browse', component: BrowseStub },
        { path: 'reader/a/:id', component: ReaderStub },
        { path: '**', component: Blank },
      ]),
      { provide: AuthService, useValue: auth },
      { provide: ModulesService, useValue: modules },
      { provide: NewNoteService, useValue: newNote },
      // A fixed platform in every case, never the machine's own.
      { provide: APPLE, useValue: apple ?? false },
    ],
  });
  // Made first, as the app shell makes it, before any screen's listener.
  const keys = TestBed.inject(ShortcutsService);
  const opened = vi.fn();
  keys.attachBox(opened);
  const harness = await RouterTestingHarness.create(url);
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigateByUrl');
  const settle = () => harness.fixture.whenStable();
  return { keys, harness, router, navigate, opened, modules, newNote, settle };
}

const hosts: HTMLElement[] = [];

/** An element of `html` in the page, to type from. */
function inPage(html: string, select: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  hosts.push(host);
  return host.querySelector<HTMLElement>(select)!;
}

describe('the app-wide keys (#289)', () => {
  beforeEach(() => {
    ReaderStub.heard = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    hosts.splice(0).forEach((host) => host.remove());
  });

  describe('the letters', () => {
    it('gives every place a letter of its own', () => {
      const letters = PLACE_ORDER.map((id) => GO_KEYS[id]);
      expect(new Set(letters).size).toBe(Object.keys(PLACES).length);
      for (const id of Object.keys(PLACES) as PlaceId[]) expect(placeForKey(GO_KEYS[id])).toBe(id);
      expect(placeForKey('z')).toBeUndefined();
    });
  });

  describe('g then a letter', () => {
    it('goes to the place, the letter taken', async () => {
      const { router, settle } = await setup();
      const g = press('g');
      expect(g.defaultPrevented).toBe(true);
      const n = press('n');
      expect(n.defaultPrevented).toBe(true);
      await settle();
      expect(router.url).toBe('/browse');
      press('g');
      press('s');
      await settle();
      expect(router.url).toBe('/settings');
    });

    it('goes under Caps Lock too, g and its letter both capitals (#313)', async () => {
      const { router, settle } = await setup();
      expect(press('G').defaultPrevented).toBe(true);
      expect(press('N').defaultPrevented).toBe(true);
      await settle();
      expect(router.url).toBe('/browse');
    });

    it('is never started by Shift g, Caps Lock on or off, nor led by a Shift letter', async () => {
      const { keys, navigate } = await setup();
      expect(press('G', { shiftKey: true }).defaultPrevented).toBe(false);
      expect(press('g', { shiftKey: true, modifierCapsLock: true }).defaultPrevented).toBe(false);
      expect(keys.waiting).toBe(false);
      press('g');
      // Taken, as any character after g is, but no place.
      expect(press('N', { shiftKey: true }).defaultPrevented).toBe(true);
      press('g');
      press('n', { shiftKey: true, modifierCapsLock: true });
      expect(navigate).not.toHaveBeenCalled();
    });

    it('waits 1.5 s for its letter, and no longer', async () => {
      const { keys, navigate } = await setup();
      vi.useFakeTimers();
      press('g');
      vi.advanceTimersByTime(GO_WAIT_MS - 10);
      expect(keys.waiting).toBe(true);
      vi.advanceTimersByTime(20);
      expect(keys.waiting).toBe(false);
      const n = press('n');
      expect(n.defaultPrevented).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('is called off by Escape, taking it', async () => {
      const { keys, navigate } = await setup();
      press('g');
      expect(press('Escape').defaultPrevented).toBe(true);
      expect(keys.waiting).toBe(false);
      press('n');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('is called off by another key: a character is taken, Tab goes on', async () => {
      const { keys, navigate } = await setup();
      press('g');
      expect(press('x').defaultPrevented).toBe(true);
      press('n');
      expect(navigate).not.toHaveBeenCalled();
      press('g');
      expect(press('Tab').defaultPrevented).toBe(false);
      expect(keys.waiting).toBe(false);
      press('g');
      // Shift on its own neither ends nor starts anything.
      press('Shift', { shiftKey: true });
      expect(keys.waiting).toBe(true);
    });

    it('does not offer a module that is off', async () => {
      const { keys, navigate } = await setup({ kitchen: false });
      press('g');
      expect(press('k').defaultPrevented).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
      const labels = keys.commands().map((c) => c.label);
      expect(labels).not.toContain('Go to Kitchen');
      expect(labels).not.toContain('Go to Reader');
      expect(labels).toContain('Go to Right Now');
    });

    it('offers it once it is on', async () => {
      const { keys, router, settle } = await setup({ kitchen: true });
      expect(keys.commands().map((c) => c.label)).toContain('Go to Kitchen');
      press('g');
      press('k');
      await settle();
      expect(router.url).toBe('/kitchen');
    });

    it("keeps the letter from a screen's own keys: g s is Settings, never Save", async () => {
      const { router, settle } = await setup({ url: '/reader/a/x1' });
      press('g');
      press('s');
      await settle();
      expect(router.url).toBe('/settings');
      // The Reader heard `g`, which it ignores, and never the `s`.
      expect(ReaderStub.heard).toEqual(['g']);
      await router.navigateByUrl('/reader/a/x1');
      await settle();
      ReaderStub.heard = [];
      // Alone, `s` is the Reader's as before.
      expect(press('s').defaultPrevented).toBe(true);
      expect(ReaderStub.heard).toEqual(['s']);
      expect(router.url).toBe('/reader/a/x1');
    });
  });

  describe('never while typing, and never over what owns the keys', () => {
    const fields: [string, string, string][] = [
      ['a text field', '<input />', 'input'],
      ['a typed text field', '<input type="text" />', 'input'],
      ['a search field', '<input type="search" />', 'input'],
      ['a number field', '<input type="number" />', 'input'],
      ['a date field', '<input type="date" />', 'input'],
      ['a field of an unknown type', '<input type="sparkle" />', 'input'],
      ['a text area', '<textarea></textarea>', 'textarea'],
      ['a select', '<select><option>a</option></select>', 'select'],
      ['anything editable', '<div contenteditable="true"><b>x</b></div>', 'b'],
      [
        "the editor's text",
        '<div class="cm-editor"><div class="cm-content" contenteditable="true"><div class="cm-line">x</div></div></div>',
        '.cm-line',
      ],
      [
        'the editor in View',
        '<div class="cm-editor"><div class="cm-content" contenteditable="false" tabindex="0">x</div></div>',
        '.cm-content',
      ],
    ];
    for (const [what, html, select] of fields) {
      it(`leaves g, its letter and / to ${what}`, async () => {
        const { navigate, keys } = await setup();
        const target = inPage(html, select);
        expect(press('g', {}, target).defaultPrevented).toBe(false);
        expect(keys.waiting).toBe(false);
        expect(press('n', {}, target).defaultPrevented).toBe(false);
        expect(press('/', {}, target).defaultPrevented).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
      });
    }

    for (const type of ['checkbox', 'radio', 'range', 'button']) {
      it(`hears g, its letter and / on a ${type} (#313)`, async () => {
        const { router, settle } = await setup();
        const target = inPage(`<input type="${type}" />`, 'input');
        expect(press('g', {}, target).defaultPrevented).toBe(true);
        expect(press('s', {}, target).defaultPrevented).toBe(true);
        await settle();
        expect(router.url).toBe('/settings');
        expect(press('/', {}, target).defaultPrevented).toBe(true);
        await settle();
        await settle();
        expect(router.url).toBe('/browse');
      });
    }

    it('leaves the letter to a field focused after g', async () => {
      const { navigate } = await setup();
      const field = inPage('<input />', 'input');
      press('g');
      expect(press('n', {}, field).defaultPrevented).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('leaves keys held with another modifier', async () => {
      const { navigate, keys } = await setup();
      for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
        expect(press('g', { [mod]: true }).defaultPrevented).toBe(false);
        expect(press('/', { [mod]: true }).defaultPrevented).toBe(false);
      }
      expect(press('G', { shiftKey: true }).defaultPrevented).toBe(false);
      expect(keys.waiting).toBe(false);
      // A letter held with Ctrl after g calls it off and goes on.
      press('g');
      expect(press('n', { ctrlKey: true }).defaultPrevented).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('leaves a key mid-composition', async () => {
      const { keys, navigate } = await setup();
      expect(press('g', { isComposing: true }).defaultPrevented).toBe(false);
      expect(press('g', { keyCode: 229 }).defaultPrevented).toBe(false);
      expect(keys.waiting).toBe(false);
      press('g');
      press('n', { isComposing: true });
      expect(navigate).not.toHaveBeenCalled();
    });

    it('leaves a key something else took first', async () => {
      const { keys, navigate } = await setup();
      const button = inPage('<button>x</button>', 'button');
      button.addEventListener('keydown', (e) => e.preventDefault());
      press('g', {}, button);
      expect(keys.waiting).toBe(false);
      press('g');
      press('n', {}, button);
      expect(navigate).not.toHaveBeenCalled();
    });

    for (const [what, html] of [
      ['a dialog', '<dialog open><button>x</button></dialog>'],
      ['a menu', '<div role="menu"><button>x</button></div>'],
      ["the note's More", '<nav id="more-menu"><a>x</a></nav>'],
    ]) {
      it(`waits while ${what} is open`, async () => {
        const { keys, navigate, opened } = await setup();
        inPage(html, '*');
        expect(press('g').defaultPrevented).toBe(false);
        expect(keys.waiting).toBe(false);
        expect(press('/').defaultPrevented).toBe(false);
        expect(press('k', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        expect(opened).not.toHaveBeenCalled();
      });
    }

    it('is off signed out, and on the development sign-in', async () => {
      const out = await setup({ signedIn: false });
      press('g');
      press('n');
      expect(press('k', { ctrlKey: true }).defaultPrevented).toBe(false);
      expect(out.navigate).not.toHaveBeenCalled();
      expect(out.opened).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
      const dev = await setup({ url: '/dev-sign-in' });
      press('g');
      press('n');
      expect(dev.navigate).not.toHaveBeenCalled();
    });
  });

  describe('/', () => {
    it("goes to Notes' search from anywhere, its box focused", async () => {
      const { router, settle } = await setup({ url: '/home' });
      expect(press('/').defaultPrevented).toBe(true);
      await settle();
      await settle();
      expect(router.url).toBe('/browse');
      expect(document.activeElement).toBe(
        document.querySelector('app-browse input[type="search"]'),
      );
    });

    it("focuses it at once on Notes' screen", async () => {
      const { navigate } = await setup({ url: '/browse' });
      press('/');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Search notes');
      expect(navigate).not.toHaveBeenCalled();
    });

    it("opens a screen's own search instead, while it is drawn", async () => {
      const { keys, navigate } = await setup({ url: '/reader/a/x1' });
      const own = vi.fn();
      const release = keys.ownSearch(own);
      press('/');
      expect(own).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
      release();
      press('/');
      expect(own).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith('/browse');
    });
  });

  describe('Ctrl K', () => {
    it('opens the box from the page, and from a field', async () => {
      const { opened } = await setup();
      expect(press('k', { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(press('K', { ctrlKey: true }).defaultPrevented).toBe(true);
      const field = inPage('<textarea>words</textarea>', 'textarea');
      expect(press('k', { ctrlKey: true }, field).defaultPrevented).toBe(true);
      expect(opened).toHaveBeenCalledTimes(3);
    });

    it("leaves Cmd K alone off Apple's platforms (#313)", async () => {
      const { opened } = await setup({ apple: false });
      expect(press('k', { metaKey: true }).defaultPrevented).toBe(false);
      const field = inPage('<input />', 'input');
      expect(press('k', { metaKey: true }, field).defaultPrevented).toBe(false);
      expect(opened).not.toHaveBeenCalled();
    });

    it("is Cmd K on Apple's, a field's Ctrl K left to it (#313)", async () => {
      const { opened } = await setup({ apple: true });
      expect(press('k', { metaKey: true }).defaultPrevented).toBe(true);
      const field = inPage('<input value="kill this line" />', 'input');
      expect(press('k', { metaKey: true }, field).defaultPrevented).toBe(true);
      expect(opened).toHaveBeenCalledTimes(2);
      // Kill-line in a field, and nothing on the page.
      expect(press('k', { ctrlKey: true }, field).defaultPrevented).toBe(false);
      expect(press('k', { ctrlKey: true }).defaultPrevented).toBe(false);
      expect(opened).toHaveBeenCalledTimes(2);
    });

    it("takes a held chord's repeats without opening again (#313)", async () => {
      const { opened } = await setup();
      press('k', { ctrlKey: true });
      expect(press('k', { ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
      expect(press('k', { ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
      expect(opened).toHaveBeenCalledTimes(1);
    });

    it('knows an Apple platform from the browser', () => {
      const nav = (platform: string, uaPlatform?: string) =>
        ({
          platform,
          ...(uaPlatform === undefined ? {} : { userAgentData: { platform: uaPlatform } }),
        }) as unknown as Navigator;
      for (const p of ['MacIntel', 'iPhone', 'iPad', 'iPod touch']) {
        expect(applePlatform(nav(p))).toBe(true);
      }
      expect(applePlatform(nav('', 'macOS'))).toBe(true);
      for (const p of ['Win32', 'Linux x86_64', 'Linux armv81', '']) {
        expect(applePlatform(nav(p))).toBe(false);
      }
      expect(applePlatform(nav('', 'Windows'))).toBe(false);
      expect(applePlatform(nav('', 'Chrome OS'))).toBe(false);
      expect(applePlatform(undefined)).toBe(false);
    });

    it("leaves the editor's own Mod-K, a link, and other chords", async () => {
      const { opened } = await setup();
      const line = inPage(
        '<div class="cm-editor"><div class="cm-content" contenteditable="true"><div class="cm-line">x</div></div></div>',
        '.cm-line',
      );
      // CodeMirror's keymap runs on its content first and takes the key.
      line.closest('.cm-content')!.addEventListener('keydown', (e) => e.preventDefault());
      press('k', { ctrlKey: true }, line);
      press('k', { ctrlKey: true, shiftKey: true });
      press('k', { ctrlKey: true, altKey: true });
      press('k', { ctrlKey: true, metaKey: true });
      expect(opened).not.toHaveBeenCalled();
    });

    it('calls off a waiting g', async () => {
      const { keys, opened } = await setup();
      press('g');
      press('k', { ctrlKey: true });
      expect(keys.waiting).toBe(false);
      expect(opened).toHaveBeenCalledTimes(1);
    });
  });

  describe("the box's commands", () => {
    it('are the places, New note, Search notes and each page of Settings', async () => {
      const { keys, newNote, navigate } = await setup({ kitchen: true });
      const all = keys.commands();
      expect(all.map((c) => c.label)).toEqual([
        'Go to Home',
        'Go to Notes',
        'Go to Right Now',
        'Go to Kitchen',
        'Go to Reading queue',
        'Go to Map',
        'Go to Assistants',
        'Go to Settings',
        'New note',
        'Search notes',
        'Settings: Appearance',
        'Settings: Start on',
        'Settings: Modules',
        'Settings: Templates',
        'Settings: AI assistants',
        'Settings: Notifications',
        'Settings: This device',
        'Settings: Shared links',
        'Settings: Account',
      ]);
      expect(all.find((c) => c.label === 'Go to Notes')?.keys).toBe('g n');
      all.find((c) => c.label === 'New note')!.run();
      expect(newNote.start).toHaveBeenCalled();
      all.find((c) => c.label === 'Settings: This device')!.run();
      expect(navigate).toHaveBeenCalledWith('/settings/device');
    });

    it('filter by every word typed, case aside', () => {
      const all = ['Go to Notes', 'Search notes', 'Settings: Appearance', 'Go to Map'].map(
        (label) => ({ label }),
      );
      expect(filterCommands(all, '').length).toBe(4);
      expect(filterCommands(all, 'NOTES').map((c) => c.label)).toEqual([
        'Go to Notes',
        'Search notes',
      ]);
      expect(filterCommands(all, 'set app').map((c) => c.label)).toEqual(['Settings: Appearance']);
      expect(filterCommands(all, 'zebra')).toEqual([]);
    });
  });
});
