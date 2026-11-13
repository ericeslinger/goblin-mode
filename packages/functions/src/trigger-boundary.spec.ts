import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Note encryption step 3c (2026-11-13): the triggers and callables read
// a note's body and title opened, through NoteSnap (mcp/note-text.ts),
// or as stored on purpose, through `storedText`, to open with the codec
// or keep as stored on the same note. This reads their source and fails
// on a raw read of either field: `get('body')` or `get('title')`, or a
// field read off a raw snapshot's `data()`, whether chained or through a
// variable, unless that snapshot is a NoteSnap's. A guard, not a proof
// (a raw value passed through a function parameter is not followed);
// the sealed specs beside each store check what the paths do.

const FILES = [
  'notes/triggers.ts',
  'notes/on-write.ts',
  'notes/firestore-store.ts',
  'notes/history.ts',
  'notes/merge.ts',
  'notes/title.ts',
  'agent/triggers.ts',
  'agent/assigned.ts',
  'agent/firestore-store.ts',
  'agent/request.ts',
  'agent/items.ts',
  'agent/core.ts',
  'organize/apply.ts',
  'organize/triggers.ts',
  'putback/callable.ts',
  'putback/firestore.ts',
  'kitchen/triggers.ts',
  'attachments/triggers.ts',
  'push/digest-store.ts',
];

const sourceOf = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

const FIELD = `(?:body|title)`;
/** A snapshot's own field read: `.get('body')`. */
const GET = new RegExp(`\\.get\\(\\s*'${FIELD}'\\s*\\)`);
/** A field read chained onto `data()`: `.data()?.['body']`, `.data()!.title`. */
const CHAINED = new RegExp(`\\.data\\(\\)[!?]?\\.?(?:\\[\\s*'${FIELD}'\\s*\\]|${FIELD}\\b)`);

/**
 * Whether `name`, in `lines` at or before line `at`, is a NoteSnap: its
 * declaration says so, or it is taken from a list of them.
 */
function isNoteSnap(lines: string[], name: string, at: number, depth = 0): boolean {
  const root = name.split(/[.?!]/)[0];
  const decl = new RegExp(`\\b(?:const|let)\\s+${root}\\b|\\b${root}\\s*:\\s*NoteSnap\\b`);
  for (let i = at; i >= 0; i--) {
    if (!decl.test(lines[i])) continue;
    const text = lines.slice(i, i + 3).join('\n');
    if (/NoteSnap/.test(text)) return true;
    // `const snap = snaps.find(...)`: follow the list it came from.
    const from = /(\w+)\.(?:find|filter)\(/.exec(text)?.[1];
    return !!from && from !== root && depth < 3 && isNoteSnap(lines, from, i, depth + 1);
  }
  return false;
}

/** The raw reads of note text in `source`, as lines. */
function rawReads(source: string): string[] {
  const lines = source.split('\n');
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (GET.test(line)) {
      const receiver = /(\w+(?:\.\w+)*)\.get\(\s*'(?:body|title)'/.exec(line)?.[1] ?? '';
      if (!isNoteSnap(lines, receiver, i)) found.push(line.trim());
    }
    const chained = /([\w.]+)\.data\(\)[!?]?\.?(?:\[\s*'(?:body|title)'|(?:body|title)\b)/.exec(
      line,
    );
    if (chained && CHAINED.test(line) && !isNoteSnap(lines, chained[1], i)) {
      found.push(line.trim());
    }
    // `const { body } = raw.data()`: taken apart as it is read (review
    // on #264).
    const apart = /\b(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?([\w.?!]+?)\.data\(\)/.exec(
      line,
    );
    if (apart && /\b(?:body|title)\b/.test(apart[1]) && !isNoteSnap(lines, apart[2], i)) {
      found.push(line.trim());
    }
    // `const d = raw.data()`: then no `d['body']` in the same function.
    const assigned = /\b(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?([\w.?!]+?)\.data\(\)/.exec(line);
    if (assigned && !isNoteSnap(lines, assigned[2], i)) {
      const read = new RegExp(
        `\\b${assigned[1]}(?:[!?]?\\.?\\[\\s*'${FIELD}'\\s*\\]|[!?]?\\.${FIELD}\\b)(?!\\s*=[^=])`,
      );
      for (let j = i + 1; j < lines.length && !/^\}/.test(lines[j]); j++) {
        if (/^\s*(\/\/|\*)/.test(lines[j])) continue;
        if (read.test(lines[j])) found.push(lines[j].trim());
      }
    }
  });
  return found;
}

describe('the note text boundary in triggers and callables', () => {
  it.each(FILES)('%s reads no note text raw', (file) => {
    expect(rawReads(sourceOf(file))).toEqual([]);
  });

  it('catches the raw reads it is for', () => {
    const bad = [
      'const { body, kind } = snap.data()!;\nreturn body;',
      "const doc = await db.doc(paths.note(uid, id)).get();\nreturn String(doc.get('body') ?? '');",
      "const after = event.data?.after.data();\nconst items = assignedItems(String(after['body'] ?? ''));",
      "return String(snap.data()?.['title'] ?? '');",
      'const d = snap.data()!;\nreturn { title: d.title };',
    ];
    for (const source of bad) expect(rawReads(source)).not.toEqual([]);
    const fine = [
      'const note = await NoteSnap.open(codec, await tx.get(ref));\n' +
        "const body = String(note.get('body') ?? '');",
      "const d = doc.data()!;\nreturn { title: storedText(d, 'title') };",
      "function f(snap: NoteSnap) {\n  const d = snap.data() ?? {};\n  return d['body'];\n}",
    ];
    for (const source of fine) expect(rawReads(source)).toEqual([]);
  });
});
