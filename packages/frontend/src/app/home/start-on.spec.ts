import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ModulesService } from '../modules/modules.service';
import { FakeModules } from '../testing/fakes';
import { START_ON_KEY, StartOnService, startOnGuard, startPath } from './start-on';

@Component({ template: 'here' })
class Here {}

const routes = [
  { path: '', component: Here, canActivate: [startOnGuard] },
  { path: 'home', component: Here },
  { path: 'right-now', component: Here },
  { path: 'kitchen', component: Here },
  { path: 'reader', component: Here },
];

/** Opens the app cold at `url`, with what this device has stored. */
async function coldOpen(url: string, stored?: object, modules = new FakeModules()) {
  localStorage.clear();
  if (stored) localStorage.setItem(START_ON_KEY, JSON.stringify(stored));
  TestBed.configureTestingModule({
    providers: [provideRouter(routes), { provide: ModulesService, useValue: modules }],
  });
  await RouterTestingHarness.create(url);
  return TestBed.inject(Router);
}

describe('Start on (#219)', () => {
  afterEach(() => localStorage.clear());

  it('maps each choice to its screen, a module that is off to Home', () => {
    const on = { kitchen: true, reader: true, podcasts: true };
    expect(startPath('note', on)).toBe('/');
    expect(startPath('home', on)).toBe('/home');
    expect(startPath('right-now', on)).toBe('/right-now');
    expect(startPath('kitchen', on)).toBe('/kitchen');
    expect(startPath('reader', on)).toBe('/reader');
    expect(startPath('podcasts', on)).toBe('/podcasts');
    expect(startPath('kitchen', { ...on, kitchen: false })).toBe('/home');
    expect(startPath('reader', { ...on, reader: false })).toBe('/home');
    // Podcasts (#245): off, Home too.
    expect(startPath('podcasts', { ...on, podcasts: false })).toBe('/home');
  });

  it('opens on a new note until a choice is made, as before', async () => {
    const router = await coldOpen('/');
    expect(router.url).toBe('/');
    expect(TestBed.inject(StartOnService).choice()).toBe('note');
  });

  it('opens on Home once chosen', async () => {
    const router = await coldOpen('/', { choice: 'home' });
    expect(router.url).toBe('/home');
  });

  it('falls back to Home for Kitchen while Kitchen is off', async () => {
    const router = await coldOpen('/', { choice: 'kitchen' });
    expect(router.url).toBe('/home');
  });

  it('opens Kitchen when it is on', async () => {
    const modules = new FakeModules();
    modules.set('kitchen', true);
    const router = await coldOpen('/', { choice: 'kitchen' }, modules);
    expect(router.url).toBe('/kitchen');
  });

  it('goes by the modules last known while they are still being read', async () => {
    const modules = new FakeModules();
    modules.loaded.set(false);
    const router = await coldOpen('/', { choice: 'reader', reader: true }, modules);
    expect(router.url).toBe('/reader');
  });

  it('leaves a share, or any URL with more to it, as it is', async () => {
    const router = await coldOpen('/?text=hello', { choice: 'home' });
    expect(router.url).toBe('/?text=hello');
  });

  it('only on a cold open: moving to / later stays there', async () => {
    const router = await coldOpen('/right-now', { choice: 'home' });
    expect(router.url).toBe('/right-now');
    await router.navigateByUrl('/');
    expect(router.url).toBe('/');
  });

  it('keeps a choice made here, and counts it for the doc', () => {
    localStorage.clear();
    const startOn = TestBed.inject(StartOnService);
    expect(startOn.hasStoredChoice()).toBe(false);
    startOn.set('right-now');
    expect(startOn.choice()).toBe('right-now');
    expect(startOn.chosen()).toBe(1);
    expect(JSON.parse(localStorage.getItem(START_ON_KEY)!)).toEqual({ choice: 'right-now' });
    startOn.adopt('home');
    expect(startOn.chosen()).toBe(1);
    startOn.remember({ kitchen: true, reader: false, podcasts: true });
    expect(JSON.parse(localStorage.getItem(START_ON_KEY)!)).toEqual({
      choice: 'home',
      kitchen: true,
      reader: false,
      podcasts: true,
    });
  });
});
