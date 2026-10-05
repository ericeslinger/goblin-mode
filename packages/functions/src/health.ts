import { FRESH_NOTE_AFTER_MS } from '@goblin/shared';

export function healthBody(revision: string | undefined) {
  // Referencing shared code keeps the bundle honest about workspace imports.
  return { ok: true, revision: revision ?? 'local', freshNoteAfterMs: FRESH_NOTE_AFTER_MS };
}
