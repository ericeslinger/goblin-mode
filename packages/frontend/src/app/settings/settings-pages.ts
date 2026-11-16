import { type StartOn } from '@mossgoblin/schema';

/**
 * Settings as pages (#290, step 6 of the layout pass, 2026-11-16): a
 * first screen of rows, each opening its own page at
 * `/settings/<id>`. The ids are the URL's and carry nothing of the
 * gardener's, so a page is safe to keep as the last place (#272).
 */
export const SETTINGS_PAGES = [
  { id: 'appearance', name: 'Appearance' },
  { id: 'start-on', name: 'Start on' },
  { id: 'modules', name: 'Modules' },
  { id: 'templates', name: 'Templates' },
  { id: 'assistants', name: 'AI assistants' },
  { id: 'notifications', name: 'Notifications' },
  { id: 'device', name: 'This device' },
  { id: 'account', name: 'Account' },
] as const;

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]['id'];

/** A page's name, for its header and its row. */
export function pageName(id: SettingsPageId): string {
  return SETTINGS_PAGES.find((p) => p.id === id)!.name;
}

/** The page shown at `/settings` beside the list on a wide screen. */
export const FIRST_PAGE: SettingsPageId = 'appearance';

/**
 * The anchors of the one long Settings page, before #290, and the page
 * each section is on now: an old link (`/settings#downloads`, Kitchen's
 * "Switch it on in Settings", a last place kept before) lands there.
 */
export const OLD_ANCHORS: Readonly<Record<string, SettingsPageId>> = {
  'start-on': 'start-on',
  modules: 'modules',
  kitchen: 'modules',
  reader: 'modules',
  downloads: 'device',
  templates: 'templates',
  'arrival-skip': 'assistants',
  'digest-push': 'assistants',
  sealing: 'account',
};

/**
 * Start on's choices (#219), as the Settings sketch words them. `note`
 * was A new note until 2026-11-15, when it became Where I left off
 * (#272, Eric); New note beside the leaf gives the fresh note.
 */
export const START_CHOICES: { value: StartOn; label: string; about: string }[] = [
  { value: 'home', label: 'Home', about: 'Capture, Right Now and the modules' },
  {
    value: 'note',
    label: 'Where I left off',
    about: 'The note, article or screen open last on this device',
  },
  { value: 'right-now', label: 'Right Now', about: 'Reminders and what is new' },
  { value: 'kitchen', label: 'Kitchen', about: 'This week’s meals' },
  { value: 'reader', label: 'Reader', about: 'Unread articles' },
  { value: 'podcasts', label: 'Podcasts', about: 'The newest episodes' },
];
