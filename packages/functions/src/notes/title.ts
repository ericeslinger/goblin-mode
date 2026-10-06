// The core of noteTitle: when Eric settles a note (leaves it after
// changing it), ask Claude for a title and write it back, unless he set
// his own (DESIGN.md, Titles).
import { cleanTitle, wantsClaudeTitle } from '@goblin/schema';
import type { NoteState } from './history';

/** Asks a model for a title; resolves to its raw reply. */
export type Titler = (body: string) => Promise<string>;

export interface TitleStore {
  /**
   * Writes `title` (titleSource `llm`) only if the note still exists, its
   * title is not Eric's own, and it is still at the settle that asked
   * (`settledAt` unchanged), so a slow reply never lands on a note that
   * was reopened and settled again. True when written.
   */
  setTitle(uid: string, noteId: string, forSettledAt: number, title: string): Promise<boolean>;
}

/** Whether a title was asked for and written, and why not otherwise. */
export type TitleOutcome = 'written' | 'stale' | 'skipped' | 'off' | 'failed';

export async function titleNote(
  store: TitleStore,
  titler: Titler | null,
  uid: string,
  noteId: string,
  before: NoteState | undefined,
  after: NoteState | undefined,
  log: (message: string, err?: unknown) => void = () => undefined,
): Promise<TitleOutcome> {
  if (!after || after.settledAt === undefined || !wantsClaudeTitle(before, after)) {
    return 'skipped';
  }
  if (!titler) return 'off';
  let title: string;
  try {
    title = cleanTitle(await titler(after.body));
  } catch (err) {
    // The first-words title stays; the next settle tries again.
    log('title request failed', err);
    return 'failed';
  }
  if (!title) return 'failed';
  return (await store.setTitle(uid, noteId, after.settledAt, title)) ? 'written' : 'stale';
}
