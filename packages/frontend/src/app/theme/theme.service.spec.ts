import { TestBed } from '@angular/core/testing';
import { PREFERS_DARK, THEME_KEY, ThemeService } from './theme.service';
import { themeById } from './themes';

/** A stand-in for matchMedia's result that a spec can flip. */
class FakeQuery {
  private listener: ((e: { matches: boolean }) => void) | undefined;
  constructor(public matches: boolean) {}
  addEventListener(_type: string, listener: (e: { matches: boolean }) => void): void {
    this.listener = listener;
  }
  flip(matches: boolean): void {
    this.matches = matches;
    this.listener?.({ matches });
  }
}

function setup(stored?: unknown, systemDark = false) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(THEME_KEY, JSON.stringify(stored));
  const query = new FakeQuery(systemDark);
  TestBed.configureTestingModule({
    providers: [{ provide: PREFERS_DARK, useValue: query }],
  });
  const service = TestBed.inject(ThemeService);
  TestBed.tick();
  return { service, query, root: document.documentElement };
}

const prop = (name: string) => document.documentElement.style.getPropertyValue(name);

describe('ThemeService', () => {
  afterEach(() => localStorage.clear());

  it('starts on the default theme, following the system', () => {
    const { service, root } = setup();
    expect(service.theme()).toBe('herbarium');
    expect(service.mode()).toBe('system');
    expect(root.dataset['theme']).toBe('herbarium');
    expect(root.dataset['mode']).toBe('light');
    expect(prop('--bg')).toBe(themeById('herbarium').light.bg);
  });

  it('follows the system into dark and back', () => {
    const { query, root } = setup(undefined, true);
    expect(root.dataset['mode']).toBe('dark');
    expect(prop('--ink')).toBe(themeById('herbarium').dark.ink);
    query.flip(false);
    TestBed.tick();
    expect(root.dataset['mode']).toBe('light');
  });

  it('switches theme and mode, and remembers them on this device', () => {
    const { service, root } = setup();
    service.set('pixel', 'dark');
    TestBed.tick();
    expect(root.dataset['theme']).toBe('pixel');
    expect(prop('--accent')).toBe(themeById('pixel').dark.accent);
    expect(prop('--font-heading')).toContain('Pixelify Sans Variable');
    expect(JSON.parse(localStorage.getItem(THEME_KEY)!)).toEqual({ theme: 'pixel', mode: 'dark' });
  });

  it('restores a stored choice, and ignores a corrupt one', () => {
    expect(setup({ theme: 'night', mode: 'dark' }).root.dataset['theme']).toBe('night');
    TestBed.resetTestingModule();
    const { service } = setup({ theme: 'nope', mode: 'sideways' });
    expect(service.theme()).toBe('herbarium');
    expect(service.mode()).toBe('system');
  });

  it('keeps the browser theme color in step', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
    const { service } = setup();
    service.set('moss', 'light');
    TestBed.tick();
    expect(meta.content).toBe(themeById('moss').light.bg);
    meta.remove();
  });
});
