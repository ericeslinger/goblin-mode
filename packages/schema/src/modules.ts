// Modules (#126, Eric 2026-10-18): bundles of note kinds, screens and
// Claude tools, switched on per user. The code ships with the app; which
// are on, and their configuration, are data (`settings/modules`).

export const MODULES = [
  {
    id: 'projects',
    label: 'Projects',
    about: 'Projects with a parent, a kind and a status, their items, stages and tasks.',
    // On when never set, so turning modules on changes nothing for anyone.
    defaultOn: true,
  },
  {
    id: 'kitchen',
    label: 'Kitchen',
    about: 'Recipes, a weekly meal plan, the grocery list and what is on hand (#125).',
    defaultOn: false,
  },
  {
    id: 'reader',
    label: 'Reader',
    about: 'Feeds you follow, in folders, read in the app and filed in the garden (#159).',
    defaultOn: false,
  },
  {
    id: 'podcasts',
    label: 'Podcasts',
    about: 'Shows you follow, their newest episodes, and the player (#244).',
    defaultOn: false,
    // Until switched itself, it follows the Reader's switch (#245,
    // 2026-11-10): podcasts came out of the Reader, so whoever had them
    // there keeps them, and a Reader never switched on brings none.
    follows: 'reader',
  },
] as const;
export type ModuleId = (typeof MODULES)[number]['id'];

/**
 * Whether module `id` is on, given the stored settings (or none yet):
 * its switch, else the switch of the module it follows, else its default.
 */
export function moduleOn(
  settings: Partial<Record<ModuleId, { enabled?: unknown } | undefined>> | undefined,
  id: ModuleId,
): boolean {
  const stored = settings?.[id]?.enabled;
  if (typeof stored === 'boolean') return stored;
  const module = MODULES.find((m) => m.id === id);
  if (module && 'follows' in module) return moduleOn(settings, module.follows);
  return module?.defaultOn ?? false;
}
