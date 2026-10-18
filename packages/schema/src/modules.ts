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
] as const;
export type ModuleId = (typeof MODULES)[number]['id'];

/** Whether module `id` is on, given the stored settings (or none yet). */
export function moduleOn(
  settings: Partial<Record<ModuleId, { enabled?: unknown } | undefined>> | undefined,
  id: ModuleId,
): boolean {
  const stored = settings?.[id]?.enabled;
  if (typeof stored === 'boolean') return stored;
  return MODULES.find((m) => m.id === id)?.defaultOn ?? false;
}
