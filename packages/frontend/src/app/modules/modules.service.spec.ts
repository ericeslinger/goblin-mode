import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { signal } from '@angular/core';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { SETTINGS_API, type SettingsApi } from '../theme/theme-sync.service';
import { ModulesService } from './modules.service';

let ack: Promise<void> = Promise.resolve();

function setup() {
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
    });
    expect(api.set).toHaveBeenLastCalledWith({}, 'users/u1/settings/modules', {
      kitchen: {
        enabled: true,
        config: { weekStart: 'Sun', meals: ['lunch', 'dinner'], fishDay: 'none', sections: {} },
      },
      updatedAt: 'NOW',
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
