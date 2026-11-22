import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { signal } from '@angular/core';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { TIME_ZONE } from '../platform/platform';
import { SETTINGS_API, type SettingsApi } from '../theme/theme-sync.service';
import { ModulesService } from './modules.service';

let ack: Promise<void> = Promise.resolve();

function setup(tz = 'America/New_York') {
  let next: (data: Record<string, unknown> | undefined, local?: boolean) => void = () => undefined;
  const api = {
    listen: vi.fn((_db, _path, n) => {
      next = (d, local = false) => n(d, false, local);
      return () => undefined;
    }),
    set: vi.fn(() => ack),
    now: () => 'NOW',
  } satisfies SettingsApi;
  const user = signal<User | null | undefined>({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_API, useValue: api },
      { provide: FIREBASE, useValue: { db: {} } },
      { provide: AuthService, useValue: { user } },
      { provide: TIME_ZONE, useValue: tz },
    ],
  });
  const modules = TestBed.inject(ModulesService);
  TestBed.tick();
  return {
    modules,
    api,
    push: (d: Record<string, unknown> | undefined, local?: boolean) => next(d, local),
  };
}

describe('ModulesService (#126)', () => {
  it('reads settings/modules, Projects on until it says otherwise', () => {
    const { modules, api, push } = setup();
    expect(api.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/settings/modules',
      expect.any(Function),
      expect.any(Function),
    );
    expect(modules.projects()).toBe(true);
    push({ projects: { enabled: false } });
    expect(modules.projects()).toBe(false);
    expect(modules.on('projects')).toBe(false);
    push({ projects: 'garbled' });
    expect(modules.projects()).toBe(true);
  });

  it('switches a module, keeping its config, at once and in the doc', () => {
    const { modules, api, push } = setup();
    push({ projects: { enabled: true, config: { x: 1 } } });
    modules.set('projects', false);
    expect(modules.projects()).toBe(false);
    expect(api.set).toHaveBeenCalledWith({}, 'users/u1/settings/modules', {
      projects: { enabled: false, config: { x: 1 } },
      updatedAt: 'NOW',
    });
  });

  it('keeps quick changes: the echo of an earlier write never undoes a later one', () => {
    const { modules, api, push } = setup();
    push({ kitchen: { enabled: true } });
    modules.configureKitchen({ weekStart: 'Sun' });
    modules.configureKitchen({ meals: ['lunch', 'dinner'] });
    // The first write's echo arrives after the second change.
    push({ kitchen: { enabled: true, config: { weekStart: 'Sun' } } }, true);
    modules.configureKitchen({ fishDay: 'none' });
    expect(modules.kitchenConfig()).toEqual({
      weekStart: 'Sun',
      meals: ['lunch', 'dinner'],
      fishDay: 'none',
      sections: {},
      wrote: {},
    });
    expect(api.set).toHaveBeenLastCalledWith({}, 'users/u1/settings/modules', {
      kitchen: {
        enabled: true,
        config: {
          weekStart: 'Sun',
          meals: ['lunch', 'dinner'],
          fishDay: 'none',
          sections: {},
          wrote: {},
        },
      },
      updatedAt: 'NOW',
    });
  });

  it('sets Habits’ week start, keeping its switch and quiet hours (step 5 of #324)', () => {
    const { modules, api, push } = setup();
    const tz = 'America/New_York';
    push({ habits: { enabled: true, config: { quietFrom: '23:00', tz } } });
    modules.configureHabits({ weekStart: 'Sun' });
    expect(modules.habitsConfig()).toEqual({
      weekStart: 'Sun',
      quietFrom: '23:00',
      quietTo: '06:00',
      tz,
    });
    expect(api.set).toHaveBeenLastCalledWith({}, 'users/u1/settings/modules', {
      habits: {
        enabled: true,
        config: { weekStart: 'Sun', quietFrom: '23:00', quietTo: '06:00', tz },
      },
      updatedAt: 'NOW',
    });
  });

  describe('the device’s zone for Habits (Eric, 2026-11-22)', () => {
    const modulesWith = (tz?: string, enabled = true) => ({
      habits: { enabled, config: { weekStart: 'Sun', ...(tz ? { tz } : {}) } },
      kitchen: { enabled: true },
    });

    it('stores this device’s zone when it differs, keeping the rest, once', () => {
      const { modules, api, push } = setup('Europe/Paris');
      push(modulesWith('America/New_York'));
      TestBed.tick();
      expect(api.set).toHaveBeenCalledTimes(1);
      expect(api.set).toHaveBeenCalledWith({}, 'users/u1/settings/modules', {
        habits: {
          enabled: true,
          config: { weekStart: 'Sun', quietFrom: '22:00', quietTo: '06:00', tz: 'Europe/Paris' },
        },
        kitchen: { enabled: true },
        updatedAt: 'NOW',
      });
      expect(modules.habitsConfig().tz).toBe('Europe/Paris');
      // Its echo, and the server's copy: the same zone, nothing more.
      push(modulesWith('Europe/Paris'), true);
      push(modulesWith('Europe/Paris'));
      TestBed.tick();
      expect(api.set).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when the zone is the same, Habits is off, or nothing is read', () => {
      const same = setup('Europe/Paris');
      same.push(modulesWith('Europe/Paris'));
      TestBed.tick();
      expect(same.api.set).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
      const off = setup('Europe/Paris');
      off.push(modulesWith('America/New_York', false));
      TestBed.tick();
      expect(off.api.set).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
      const unread = setup('Europe/Paris');
      TestBed.tick();
      expect(unread.api.set).not.toHaveBeenCalled();
    });

    it('stores one where none was, as for a module switched on before', () => {
      const { api, push } = setup('Asia/Tokyo');
      push(modulesWith());
      TestBed.tick();
      expect(api.set).toHaveBeenCalledTimes(1);
      expect(api.set).toHaveBeenCalledWith(
        {},
        'users/u1/settings/modules',
        expect.objectContaining({
          habits: expect.objectContaining({
            config: expect.objectContaining({ tz: 'Asia/Tokyo' }),
          }),
        }),
      );
    });

    it('never writes back and forth with a device in another zone: once a use', async () => {
      const { api, push } = setup('Europe/Paris');
      push(modulesWith('America/New_York'));
      TestBed.tick();
      expect(api.set).toHaveBeenCalledTimes(1);
      // Acknowledged, so another device's change is taken again.
      await new Promise((done) => setTimeout(done));
      // The laptop at home, also open, writes its zone afterwards: this
      // device leaves it until it is used again.
      push(modulesWith('America/New_York'));
      TestBed.tick();
      expect(api.set).toHaveBeenCalledTimes(1);
      // Brought back to the front: a new use, and its zone again.
      document.dispatchEvent(new Event('visibilitychange'));
      TestBed.tick();
      expect(api.set).toHaveBeenCalledTimes(2);
      expect(api.set).toHaveBeenLastCalledWith(
        {},
        'users/u1/settings/modules',
        expect.objectContaining({
          habits: expect.objectContaining({
            config: expect.objectContaining({ tz: 'Europe/Paris' }),
          }),
        }),
      );
    });
  });

  it('takes no older snapshot while its own writes are unacknowledged (2026-10-18)', async () => {
    const { modules, push } = setup();
    push({ kitchen: { enabled: true } });
    let acked!: () => void;
    ack = new Promise((done) => (acked = done));
    modules.configureKitchen({ weekStart: 'Sun' });
    // The server's copy from before the change, delivered after it.
    push({ kitchen: { enabled: true } });
    expect(modules.kitchenConfig().weekStart).toBe('Sun');
    acked();
    await ack;
    await Promise.resolve();
    ack = Promise.resolve();
    // Acknowledged: another device's change is taken again.
    push({ kitchen: { enabled: true, config: { weekStart: 'Wed' } } });
    expect(modules.kitchenConfig().weekStart).toBe('Wed');
  });
});
