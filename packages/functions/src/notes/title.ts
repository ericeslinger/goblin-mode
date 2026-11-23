// The core of noteTitle: when Eric settles a note (leaves it after
// changing it), ask Claude for a title and write it back, unless he set
// his own, or the title already there was made from the same text
// (2026-11-22) (DESIGN.md, Titles).
import { cleanTitle, wantsClaudeTitle } from '@mossgoblin/schema';
import type { NoteState } from './history';

/** How much of a note the model sees: what its title is made from. */
export const TITLE_CONTEXT_CHARS = 2000;

/** The text of `body` a title is made from: its first TITLE_CONTEXT_CHARS. */
export function titleText(body: string): string {
  return body.slice(0, TITLE_CONTEXT_CHARS);
}

/** Asks a model for a title of `text` (`titleText`); resolves to its raw reply. */
export type Titler = (text: string) => Promise<string>;

export interface TitleStore {
  /**
   * The keyed hash of a model title and the text it was made from
   * (`noteTitleHash`); throws SealedNoteError with no key.
   */
  titleHash(noteId: string, title: string, text: string): Promise<string>;
  /**
   * Writes `title` (titleSource `llm`) and `titleHash`, what it was made
   * from, when there is one, only if the note still exists, its title is
   * not Eric's own, and it is still at the settle that asked
   * (`settledAt` unchanged), so a slow reply never lands on a note that
   * was reopened and settled again. True when written.
   */
  setTitle(
    uid: string,
    noteId: string,
    forSettledAt: number,
    title: string,
    titleHash?: string,
  ): Promise<boolean>;
}

/**
 * Whether a title was asked for and written, and why not otherwise;
 * `same`: the model title there was made from the same text, so the
 * model was not asked (2026-11-22).
 */
export type TitleOutcome = 'written' | 'stale' | 'skipped' | 'same' | 'off' | 'failed';

/**
 * A settle's title. The model is asked only when it could change the
 * title (2026-11-22): a settle means the note was written since the
 * last, but not that the text a title is made from changed (a line
 * or a tick past the first TITLE_CONTEXT_CHARS, an edit put back), so a
 * model title whose `titleHash` still matches it and the text is kept
 * as it is, at no cost. Any other title (first words, one Claude set
 * through the tools) has no matching hash and is asked for as before.
 */
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
  const text = titleText(after.body);
  if (after.titleSource === 'llm' && after.titleHash) {
    const had = await hashOf(store, noteId, after.title, text, log);
    if (had === after.titleHash) return 'same';
  }
  let title: string;
  try {
    title = cleanTitle(await titler(text));
  } catch (err) {
    // The first-words title stays; the next settle tries again.
    log('title request failed', err);
    return 'failed';
  }
  if (!title) return 'failed';
  const hash = await hashOf(store, noteId, title, text, log);
  return (await store.setTitle(uid, noteId, after.settledAt, title, hash)) ? 'written' : 'stale';
}

/** The hash, or undefined when it cannot be made: then the model is asked. */
async function hashOf(
  store: TitleStore,
  noteId: string,
  title: string,
  text: string,
  log: (message: string, err?: unknown) => void,
): Promise<string | undefined> {
  try {
    return await store.titleHash(noteId, title, text);
  } catch (err) {
    log('title hash failed', err);
    return undefined;
  }
}
