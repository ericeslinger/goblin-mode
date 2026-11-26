// What a note's public copy holds (2026-11-26, Eric; DESIGN.md, Sharing
// a public copy): its kind, its title and its body with the app's
// machinery taken out (`publicCopy`), and a recipe's source link. Made
// from the note as this device opened it, so its words are the plain
// ones Eric sees; nothing else of the note goes with it.
import { publicCopy } from '@mossgoblin/editor/grammar';
import {
  SHARE_BODY_MAX,
  SHARE_TITLE_MAX,
  type ShareKind,
  shareKindOf,
  shareSource,
} from '@mossgoblin/schema';
import type { NoteRecord } from '../notes/notes.service';

/** The copy's fields, as the share's document holds them. */
export interface ShareCopy {
  kind: ShareKind;
  title: string;
  body: string;
  source?: string;
}

/** The copy of `note` as it stands, or undefined when it cannot be shared. */
export function shareCopyOf(note: NoteRecord): ShareCopy | undefined {
  const kind = shareKindOf(note.kind);
  if (!kind || note.locked) return undefined;
  const source = kind === 'recipe' ? shareSource(note.source?.url) : undefined;
  const title = note.title.trim().slice(0, SHARE_TITLE_MAX);
  // Never thrown into a template: a body the grammar cannot read has no copy.
  let body: string;
  try {
    body = withoutTitleLine(publicCopy(note.body), title);
  } catch {
    return undefined;
  }
  return { kind, title, body, ...(source ? { source } : {}) };
}

/**
 * `body` without its first line when that line is the title (a note's
 * title is often its first words): the page shows the title once, as
 * its heading.
 */
export function withoutTitleLine(body: string, title: string): string {
  const lines = body.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first === -1 || !title) return body;
  const line = lines[first]
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .trim();
  if (line !== title) return body;
  return lines
    .slice(first + 1)
    .join('\n')
    .replace(/^\s*\n/, '');
}

/** Whether two copies say the same: Update the shared copy is offered when not. */
export function sameCopy(a: ShareCopy, b: Partial<ShareCopy> | undefined): boolean {
  return (
    !!b &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.body === b.body &&
    (a.source ?? '') === (b.source ?? '')
  );
}

/** Why `note` cannot be shared now, in plain words, or undefined when it can. */
export function shareRefusal(
  note: NoteRecord | undefined,
  heldForKey: boolean,
): string | undefined {
  if (!note) return 'This note is not saved yet.';
  if (note.locked) return 'This note is sealed and its key is not on this device yet.';
  if (heldForKey) return 'Its words are still waiting on this device to be saved.';
  if (!shareKindOf(note.kind)) return 'Only notes and recipes can be shared.';
  const copy = shareCopyOf(note);
  if (!copy) return 'Its text could not be read for sharing.';
  if (!copy.title.trim() && !copy.body.trim()) return 'There is nothing in it to share yet.';
  if (copy.body.length > SHARE_BODY_MAX) {
    return (
      `It is too long to share as a link: a shared copy holds at most ` +
      `${SHARE_BODY_MAX.toLocaleString('en')} characters, and this has ` +
      `${copy.body.length.toLocaleString('en')}.`
    );
  }
  return undefined;
}
