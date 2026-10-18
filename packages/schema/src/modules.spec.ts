import { describe, expect, it } from 'vitest';
import { MODULES, moduleOn } from './modules';
import { ModuleSettings } from './model';

describe('moduleOn (#126)', () => {
  it('reads the switch, else the module’s default', () => {
    expect(moduleOn(undefined, 'projects')).toBe(true);
    expect(moduleOn({}, 'projects')).toBe(true);
    expect(moduleOn({ projects: { enabled: false } }, 'projects')).toBe(false);
    expect(moduleOn({ projects: { enabled: 'no' } }, 'projects')).toBe(true);
    expect(MODULES.map((m) => m.id)).toEqual(['projects', 'kitchen']);
    expect(moduleOn(undefined, 'kitchen')).toBe(false);
    expect(moduleOn({ kitchen: { enabled: true } }, 'kitchen')).toBe(true);
  });

  it('keeps a module’s config as it is', () => {
    const parsed = ModuleSettings.parse({
      projects: { enabled: true, config: { anything: [1] } },
      updatedAt: { seconds: 1, nanoseconds: 0 },
    });
    expect(parsed.projects?.config).toEqual({ anything: [1] });
  });
});
