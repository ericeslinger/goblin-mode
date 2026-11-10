import { describe, expect, it } from 'vitest';
import { MODULES, moduleOn } from './modules';
import { ModuleSettings } from './model';

describe('moduleOn (#126)', () => {
  it('reads the switch, else the module’s default', () => {
    expect(moduleOn(undefined, 'projects')).toBe(true);
    expect(moduleOn({}, 'projects')).toBe(true);
    expect(moduleOn({ projects: { enabled: false } }, 'projects')).toBe(false);
    expect(moduleOn({ projects: { enabled: 'no' } }, 'projects')).toBe(true);
    expect(MODULES.map((m) => m.id)).toEqual(['projects', 'kitchen', 'reader', 'podcasts']);
    expect(moduleOn(undefined, 'kitchen')).toBe(false);
    expect(moduleOn({ kitchen: { enabled: true } }, 'kitchen')).toBe(true);
    expect(moduleOn(undefined, 'reader')).toBe(false);
  });

  it('keeps Podcasts with the Reader until switched itself (#245)', () => {
    expect(moduleOn(undefined, 'podcasts')).toBe(false);
    expect(moduleOn({ reader: { enabled: true } }, 'podcasts')).toBe(true);
    expect(moduleOn({ reader: { enabled: false } }, 'podcasts')).toBe(false);
    expect(moduleOn({ reader: { enabled: true }, podcasts: { enabled: false } }, 'podcasts')).toBe(
      false,
    );
    expect(moduleOn({ podcasts: { enabled: true } }, 'podcasts')).toBe(true);
    // The Reader's own switch is its own.
    expect(moduleOn({ podcasts: { enabled: true } }, 'reader')).toBe(false);
  });

  it('keeps a module’s config as it is', () => {
    const parsed = ModuleSettings.parse({
      projects: { enabled: true, config: { anything: [1] } },
      updatedAt: { seconds: 1, nanoseconds: 0 },
    });
    expect(parsed.projects?.config).toEqual({ anything: [1] });
  });
});
