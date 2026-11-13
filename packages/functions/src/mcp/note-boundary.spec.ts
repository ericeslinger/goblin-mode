import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Note encryption step 3b (2026-11-12): the tools read and write note
// documents only through the note text boundary in tools.ts (readNote,
// readNotes, queryNotes, writeNote), which opens and seals body and
// title, and since 2026-11-13 every sealed field (SEALED_FIELDS). This
// reads the source and fails on a Firestore read or write outside it
// that is not plainly about another collection, or a stored value read
// off a NoteSnap, so a new tool cannot reach a note's raw text by
// accident. A guard, not a proof: the specs in note-text.spec.ts check
// what the boundary does.
const source = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');

/** tools.ts without the boundary itself, and without parentTitle (below). */
function outsideBoundary(): string[] {
  const start = source.indexOf('// The note text boundary (2026-11-12).');
  const end = source.indexOf('// End of the note text boundary.');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // parentTitle is exported for put back and reads only a project's
  // filing and its title, which it leaves unsaid when sealed.
  const pStart = source.indexOf('export async function parentTitle(');
  const pEnd = source.indexOf('\n}\n', pStart);
  expect(pStart).toBeGreaterThan(0);
  return [source.slice(0, pStart), source.slice(pEnd, start), source.slice(end)].flatMap((part) =>
    part.split('\n'),
  );
}

/**
 * A Firestore read or write call. A NoteSnap's `get('field')` is the
 * boundary's own, opened; a snapshot read is `.get()` with no field.
 */
const CALL =
  /\btx\.(get|getAll)\(|\b(tx|batch|ref)\.(set|update|create|delete)\(|\.get\(\)|\.getAll\(/;
/** What a raw call may be about: another collection than the notes. */
const OTHER = /this\.(attachments|feeds|feedItems|reminders)\(\)|paths\.modules/;

/** The line where `name` was last given a value, at or before line `at`. */
function definition(lines: string[], name: string, at: number, depth = 0): string {
  const assigned = new RegExp(`\\b(const|let)\\s+${name}\\b|^\\s*${name}\\s*=[^=]`);
  for (let i = at; i >= 0; i--) {
    if (!assigned.test(lines[i])) continue;
    const text = `${lines[i]}\n${lines[i + 1] ?? ''}`;
    if (OTHER.test(text) || /this\.notes\(\)/.test(text) || depth > 2) return text;
    // Built from another query (`items.where(...)`): follow that one.
    const from = [...text.matchAll(/\b(\w+)\.(?:where|orderBy|select|limit|doc)\(/g)]
      .map((m) => m[1])
      .filter((n) => n !== name && n !== 'this');
    return from.map((n) => definition(lines, n, i, depth + 1)).join('\n') || text;
  }
  return '';
}

/** What the call on line `i` reads or writes, as the source names it. */
function target(lines: string[], i: number): string {
  const line = lines[i];
  // tx.get(ref), tx.update(ref, ...): the first argument.
  const arg = /\b(?:tx|batch)\.\w+\(\s*(\w+)/.exec(line)?.[1];
  if (arg) return definition(lines, arg, i);
  // ref.get(), q.get(): the receiver.
  const receiver = /\b(\w+)\.(?:get|getAll|set|update)\(/.exec(line)?.[1];
  if (receiver && receiver !== 'this')
    return OTHER.test(line) ? line : definition(lines, receiver, i);
  // A chain ending `.get()` on its own line: the statement it ends.
  let j = i;
  while (j > 0 && !/\bawait\s/.test(lines[j])) j--;
  const start = /await\s+(\w+)\s*$|await\s+(\w+)\./.exec(lines[j]);
  const name = start?.[1] ?? start?.[2];
  return name && name !== 'this' ? definition(lines, name, j) : lines[j];
}

/**
 * A stored value read off a NoteSnap: `stored()` gives sealed fields as
 * they are, so outside the boundary a sealed field's raw value would be
 * read as its text (step 3d, 2026-11-13: every sealed field, not only
 * body and title). The boundary's own `touchedFieldsOf` keeps values
 * before as stored on purpose.
 */
const STORED = /\.stored\(\)/;

describe('the note text boundary', () => {
  it('reads no stored value off a NoteSnap outside the boundary', () => {
    expect(outsideBoundary().filter((line) => STORED.test(line))).toEqual([]);
    // What it is for: a planted raw read of a sealed field is caught.
    for (const planted of [
      "const ask = doc.stored()!['sendAsk'];",
      'const names = (note.stored()?.synonyms as string[]) ?? [];',
      "return String(found.stored()?.['instructions'] ?? '');",
    ])
      expect(STORED.test(planted)).toBe(true);
  });

  it('is the only place the tools read or write a note document', () => {
    const lines = outsideBoundary();
    const raw = lines.flatMap((line, i) => {
      if (!CALL.test(line)) return [];
      // The run's activity entry, written beside the change.
      if (/^\s*(tx|batch)\.set\((\.\.\.this\.activity\(|$)/.test(line)) {
        if (/this\.activity\(/.test(line + lines[i + 1])) return [];
      }
      if (OTHER.test(line)) return [];
      const about = target(lines, i);
      return OTHER.test(about) && !/this\.notes\(\)/.test(about) ? [] : [line.trim()];
    });
    expect(raw).toEqual([]);
  });

  it('leaves no raw note collection read', () => {
    const lines = outsideBoundary().join('\n');
    // this.notes() goes to queryNotes, or to .doc(id) for a ref that
    // writeNote writes; never straight to a read.
    expect(lines).not.toMatch(/this\.notes\(\)(\s*\.\w+\([^)]*\))*\s*\.get\(/);
  });
  // The first check knows a write by its receiver's name, so the names
  // are fixed here too (review on #263: `t.set(...)` and a write
  // chained straight onto a note ref slipped past it).
  it('names every transaction tx and every batch batch, so their writes are seen', () => {
    const all = outsideBoundary().join('\n');
    const params = [...all.matchAll(/runTransaction\(\s*(?:async\s*)?\(?\s*(\w+)/g)].map(
      (m) => m[1],
    );
    expect(params.length).toBeGreaterThan(0);
    expect(params.filter((p) => p !== 'tx')).toEqual([]);
    const batches = [...all.matchAll(/(\w+)\s*=\s*this\.db\.batch\(\)/g)].map((m) => m[1]);
    expect(batches.filter((b) => b !== 'batch')).toEqual([]);
    expect(all).not.toMatch(/this\.db\.batch\(\)\s*\./);
  });

  it('leaves no read or write chained onto the note collection or a doc of it', () => {
    const all = outsideBoundary().join('\n');
    // `this.notes()` then anything up to the end of its statement,
    // ending in a Firestore call made on it directly.
    const chained = [
      ...all.matchAll(
        /this\.notes\(\)(?:\s*\.(?:doc|where|orderBy|select|limit)\((?:[^()]|\([^()]*\))*\))*\s*\.(get|set|update|create|delete)\(/g,
      ),
    ].map((m) => m[0].replace(/\s+/g, ' '));
    expect(chained).toEqual([]);
  });
});
