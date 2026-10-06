// The collections the client writes directly, and so the ones that get
// generated shape validators in firestore.rules. Function-only
// collections (history, activity, oauth) are `allow write: if false`
// and need none. See the write-path table in model.ts.
import { Device, Note, Reminder, Timestamp } from '../model';
import { generatedBlock, type ValidatedCollection } from './generate';

export const CLIENT_WRITTEN: ValidatedCollection[] = [
  { name: 'Note', schema: Note },
  { name: 'Reminder', schema: Reminder },
  { name: 'Device', schema: Device },
];

/** The generated block for firestore.rules, plus any warnings. */
export function renderRulesBlock(): { block: string; warnings: string[] } {
  const warnings: string[] = [];
  const block = generatedBlock(CLIENT_WRITTEN, Timestamp, (w) => warnings.push(w));
  return { block, warnings };
}
