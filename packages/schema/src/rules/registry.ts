// The collections the client writes directly, and so the ones that get
// generated shape validators in firestore.rules. Function-only
// collections (history, activity, oauth) are `allow write: if false`
// and need none. See the write-path table in model.ts.
import {
  AssistantSettings,
  Attachment,
  Device,
  Feed,
  Habit,
  HabitEntry,
  HabitLog,
  ModuleSettings,
  Note,
  ReaderSettings,
  Reminder,
  Settings,
  Share,
  Timestamp,
} from '../model';
import { generatedBlock, type ValidatedCollection } from './generate';

export const CLIENT_WRITTEN: ValidatedCollection[] = [
  { name: 'Note', schema: Note },
  { name: 'Reminder', schema: Reminder },
  { name: 'Device', schema: Device },
  { name: 'Settings', schema: Settings },
  { name: 'ModuleSettings', schema: ModuleSettings },
  { name: 'Attachment', schema: Attachment },
  { name: 'Feed', schema: Feed },
  { name: 'ReaderSettings', schema: ReaderSettings },
  { name: 'AssistantSettings', schema: AssistantSettings },
  { name: 'Habit', schema: Habit },
  { name: 'HabitLog', schema: HabitLog },
  { name: 'Share', schema: Share },
];

/**
 * Shapes stored inside a client-written document, as a map value the
 * generated validator only types as `map`, that the hand-written rules
 * check one by one with their own generated validator (2026-11-21,
 * review of #327): a habit log's day entries, `isHabitEntry`.
 */
export const NESTED: ValidatedCollection[] = [{ name: 'HabitEntry', schema: HabitEntry }];

/** The generated block for firestore.rules, plus any warnings. */
export function renderRulesBlock(): { block: string; warnings: string[] } {
  const warnings: string[] = [];
  const block = generatedBlock([...CLIENT_WRITTEN, ...NESTED], Timestamp, (w) => warnings.push(w));
  return { block, warnings };
}
