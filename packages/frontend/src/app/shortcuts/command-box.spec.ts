import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { NewNoteService } from '../home/new-note';
import { ModulesService } from '../modules/modules.service';
import { FakeAuthService, FakeModules } from '../testing/fakes';
import { CommandBox } from './command-box';
import { ShortcutsService } from './shortcuts.service';

beforeAll(() => {
  // jsdom has no modal dialogs; the browser keeps focus inside and closes on Escape.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

@Component({ template: '' })
class Blank {}

/** The shell as far as the box goes: a field to come from, and the box. */
@Component({
  imports: [CommandBox],
  template: `<textarea aria-label="Draft">kiln wash</textarea>
    <button type="button">Elsewhere</button>
    <app-command-box />`,
})
class Shell {}

function press(key: string, init: KeyboardEventInit, target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

async function setup({ kitchen = false } = {}) {
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1', email: 'eric@example.com' } as User);
  const modules = new FakeModules();
  if (kitchen) modules.set('kitchen', true);
  const newNote = { start: vi.fn(() => Promise.resolve()) };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'home', component: Shell },
        { path: '**', component: Blank },
      ]),
      { provide: AuthService, useValue: auth },
      { provide: ModulesService, useValue: modules },
      { provide: NewNoteService, useValue: newNote },
    ],
  });
  TestBed.inject(ShortcutsService);
  const harness = await RouterTestingHarness.create('/home');
  const el = harness.routeNativeElement as HTMLElement;
  const dialog = el.querySelector('dialog')!;
  const input = () => dialog.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const options = () => [...dialog.querySelectorAll<HTMLElement>('[role="option"]')];
  const labels = () => options().map((o) => o.querySelector('.label')!.textContent!.trim());
  const selected = () =>
    options()
      .filter((o) => o.getAttribute('aria-selected') === 'true')
      .map((o) => o.querySelector('.label')!.textContent!.trim());
  const textarea = el.querySelector('textarea')!;
  const draw = () => harness.fixture.whenStable();
  const typeInBox = async (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    await draw();
  };
  const open = async (from: HTMLElement = textarea) => {
    from.focus();
    press('k', { ctrlKey: true }, from);
    await draw();
  };
  return {
    harness,
    el,
    dialog,
    input,
    options,
    labels,
    selected,
    textarea,
    draw,
    typeInBox,
    open,
    newNote,
    router: TestBed.inject(Router),
  };
}

describe('the command box (#289)', () => {
  it('opens on Ctrl K, a labelled combobox over every command, its field focused', async () => {
    const { dialog, input, labels, selected, open } = await setup();
    expect(dialog.open).toBe(false);
    await open();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(dialog.querySelector('label')!.textContent).toBe('Go to or do');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(input().getAttribute('aria-controls')).toBe('command-box-list');
    expect(dialog.querySelector('#command-box-list')!.getAttribute('role')).toBe('listbox');
    expect(labels()).toContain('Go to Notes');
    expect(labels()).toContain('New note');
    expect(labels()).toContain('Search notes');
    expect(labels()).toContain('Settings: Appearance');
    // A module that is off is not offered.
    expect(labels()).not.toContain('Go to Kitchen');
    expect(selected()).toEqual(['Go to Home']);
    expect(input().getAttribute('aria-activedescendant')).toBe('command-go-home');
    // With nothing typed, the keys.
    const hints = dialog.querySelector('[aria-label="Keys"]')!.textContent!;
    expect(hints).toContain('search');
    expect(hints).toContain('h Home, n Notes, r Right Now');
    expect(hints).not.toContain('k Kitchen');
  });

  it('filters as it is typed; nothing matching says so', async () => {
    const { dialog, input, labels, typeInBox, open } = await setup();
    await open();
    await typeInBox('set app');
    expect(labels()).toEqual(['Settings: Appearance']);
    expect(input().getAttribute('aria-activedescendant')).toBe('command-settings-appearance');
    expect(dialog.querySelector('[aria-label="Keys"]')).toBeNull();
    await typeInBox('NOTES');
    expect(labels()).toEqual(['Go to Notes', 'Search notes']);
    await typeInBox('zebra');
    expect(labels()).toEqual([]);
    expect(dialog.textContent).toContain('Nothing matches.');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().hasAttribute('aria-controls')).toBe(false);
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('moves with Up and Down, round the ends', async () => {
    const { input, selected, typeInBox, draw, open } = await setup();
    await open();
    await typeInBox('notes');
    expect(press('ArrowDown', {}, input()).defaultPrevented).toBe(true);
    await draw();
    expect(selected()).toEqual(['Search notes']);
    expect(input().getAttribute('aria-activedescendant')).toBe('command-search-notes');
    press('ArrowDown', {}, input());
    await draw();
    expect(selected()).toEqual(['Go to Notes']);
    press('ArrowUp', {}, input());
    await draw();
    expect(selected()).toEqual(['Search notes']);
  });

  it('runs the active one on Enter, and closes', async () => {
    const { dialog, input, typeInBox, router, draw, open } = await setup();
    await open();
    await typeInBox('right');
    expect(press('Enter', {}, input()).defaultPrevented).toBe(true);
    await draw();
    expect(dialog.open).toBe(false);
    expect(router.url).toBe('/right-now');
  });

  it('runs New note from the list, as its button does', async () => {
    const { input, typeInBox, newNote, open } = await setup();
    await open();
    await typeInBox('new');
    press('Enter', {}, input());
    expect(newNote.start).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape, the focus back where it was, the text and caret as they were', async () => {
    const { dialog, input, textarea, draw, open } = await setup();
    textarea.focus();
    textarea.setSelectionRange(4, 4);
    await open(textarea);
    expect(document.activeElement).toBe(input());
    expect(press('Escape', {}, input()).defaultPrevented).toBe(true);
    await draw();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('kiln wash');
    expect(textarea.selectionStart).toBe(4);
  });

  it('closes on Ctrl K again, the focus back on the button it came from', async () => {
    const { el, dialog, input, draw, open } = await setup();
    const button = el.querySelector('button')!;
    await open(button);
    press('k', { ctrlKey: true }, input());
    await draw();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('keeps what is typed in it from the screen under it', async () => {
    const { input, typeInBox, open } = await setup();
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    try {
      await open();
      await typeInBox('j');
      press('j', {}, input());
      press('s', {}, input());
      press('Escape', {}, input());
      expect(heard).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', heard);
    }
  });

  it('opens afresh: nothing typed, the first one active', async () => {
    const { input, labels, typeInBox, selected, open } = await setup({ kitchen: true });
    await open();
    await typeInBox('map');
    press('Escape', {}, input());
    await open();
    expect(input().value).toBe('');
    expect(labels()).toContain('Go to Kitchen');
    expect(selected()).toEqual(['Go to Home']);
  });
});
