import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEALED_FIELDS } from '@mossgoblin/schema';
import { describe, expect, it } from 'vitest';

// The gardener's switch (2026-11-15): every write of a note's sealed
// fields goes through the one form decision that reads the switch. On
// the server that is `sealFields` (mcp/note-text.ts), which reads it
// from the codec whatever forms it is given, and a new note's forms come
// from the codec (`NotesTools.newForms`) or from its sources
// (`formFrom`), never a bare PLAIN. In the app it is the write seam
// (`sealWrite`, notes.service.ts) every NotesService write goes through.
// This reads the functions' and the app's source and fails where a
// writer would seal, or choose a note's forms, around that decision. A
// guard, not a proof; the sealing specs check what each writer stores.

const FUNCTIONS = fileURLToPath(new URL('..', import.meta.url));
const FRONTEND = fileURLToPath(new URL('../../../frontend/src', import.meta.url));

function sources(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(root, path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [relative(root, path)] : [];
  });
}
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));
const where = (root: string, test: (line: string) => boolean) =>
  sources(root)
    .filter((f) => code(join(root, f)).some(test))
    .sort();

/** Every top-level field that holds a sealed field: `source` holds `source.text`. */
const SEALED_KEYS = [...new Set(SEALED_FIELDS.map((f) => f.split('.')[0]))].join('|');
/** A sealed field written by name: `body: ...`, `'title': ...`, `update['body'] = ...`, shorthand `{ body }`. */
const SEALED_KEY = new RegExp(
  `(?:^|[\\s{,])(?:${SEALED_KEYS})\\s*[:,}]|\\[\\s*'(?:${SEALED_KEYS})(?:\\.text)?'\\s*\\]\\s*=|['"](?:${SEALED_KEYS})(?:\\.text)?['"]\\s*:`,
);
/** What names a note document: its path, the notes collection, or a fixed note's id. */
const NOTE_DOC = /paths\.note\(|paths\.notes\(|notes\(\)|notesCol|CONTEXT_ID|PANTRY_ID|FISH_ID/;

/** The call starting on line `i`, to its closing parenthesis. */
function statement(lines: string[], i: number): string {
  let depth = 0;
  const out: string[] = [];
  for (let j = i; j < lines.length && j < i + 60; j++) {
    out.push(lines[j]);
    for (const c of lines[j]) depth += c === '(' ? 1 : c === ')' ? -1 : 0;
    if (depth <= 0) break;
  }
  return out.join('\n');
}

/** The first comma of `call` outside brackets: the end of its first argument. */
function topLevelComma(call: string): number {
  let depth = 0;
  for (let i = 0; i < call.length; i++) {
    const c = call[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) return i;
  }
  return call.length;
}

/** Where `name` was last given a value or declared, at or before line `at`. */
function definitionOf(lines: string[], name: string, at: number) {
  const re = new RegExp(
    `\\b(?:const|let)\\s+(?:\\{[^}]*\\b${name}\\b[^}]*\\}|${name}\\b)|\\b${name}\\s*:\\s*\\w|^\\s*${name}\\s*=[^=]`,
  );
  for (let i = at; i >= 0; i--) if (re.test(lines[i])) return { i, text: statement(lines, i) };
  return undefined;
}

/**
 * The direct Firestore writes in `source` (`x.create(`, `.set(`,
 * `.update(`, on a transaction, a batch or a ref) that land on a note
 * document, or on a ref handed in as a DocumentReference, and carry a
 * sealed field, a parsed note or a variable built with one, without
 * going through `sealFields`. A guard, not a proof: a value built in
 * another function and passed in is not followed.
 */
function directNoteWrites(source: string): string[] {
  const lines = source.split('\n').map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l));
  const found: string[] = [];
  lines.forEach((line, i) => {
    const m = /\b(\w+)\.(create|set|update)\(/.exec(line);
    if (!m) return;
    const s = statement(lines, i);
    const call = s.slice(s.indexOf(m[0]) + m[0].length);
    let target: string;
    let data: string;
    if (/^(tx|batch|writer|t|w)$/.test(m[1])) {
      const comma = topLevelComma(call);
      target = call.slice(0, comma).trim();
      data = call.slice(comma + 1).trim();
    } else {
      target = m[1];
      data = call;
    }
    const about = /^\w+$/.test(target) ? (definitionOf(lines, target, i)?.text ?? '') : '';
    if (!NOTE_DOC.test(`${target}\n${about}`) && !/:\s*DocumentReference/.test(about)) return;
    if (/^\s*await sealFields\(/.test(data)) return;
    let text = data;
    const name = /^\s*(\w+)\s*[,)]/.exec(data)?.[1];
    if (name) {
      const d = definitionOf(lines, name, i);
      if (d && /=\s*await sealFields\(/.test(d.text)) return;
      if (d) text = lines.slice(d.i, i + 1).join('\n');
    }
    const spread = /^\s*\{\s*\.\.\.(\w+)/.exec(data)?.[1];
    if (spread) {
      const d = definitionOf(lines, spread, i);
      if (d) text += `\n${lines.slice(d.i, i + 1).join('\n')}`;
    }
    const plainText = text.replace(/['"]?[\w.]+['"]?\s*:\s*FieldValue\.delete\(\)/g, '');
    if (/Note\.parse\(/.test(data) || SEALED_KEY.test(plainText)) found.push(line.trim());
  });
  return found;
}

describe('the sealing boundary', () => {
  it('names the plain forms on the server only where the switch is applied', () => {
    // PLAIN or PLAIN_FORMS handed to a writer would choose plain past the
    // switch; the codec's `forms()` and `formFrom` are the ways in.
    const plain = (l: string) => /\bPLAIN(?:_FORMS)?\b/.test(l);
    expect(where(FUNCTIONS, plain)).toEqual(['mcp/note-text.ts']);
  });

  it('seals note text on the server only in the codec, and History’s copies by the switch', () => {
    // `sealText(` is the library's; `codec.seal(` the codec's own, which
    // sealFields calls with the forms it worked out, and History's and a
    // replaced text's copies (`keptForm`) only with the switch read.
    const raw = (l: string) => /\bsealText\(/.test(l);
    expect(where(FUNCTIONS, raw)).toEqual(['mcp/note-text.ts']);
    const codec = (l: string) => /\bcodec\.seal\(/.test(l);
    expect(where(FUNCTIONS, codec)).toEqual(['mcp/note-text.ts', 'notes/firestore-store.ts']);
    const kept = readFileSync(join(FUNCTIONS, 'notes/firestore-store.ts'), 'utf8');
    expect(kept).toMatch(
      /async function keptForm[\s\S]*?codec\.sealingOn\(\)[\s\S]*?codec\.seal\(/,
    );
  });

  it('decides the form a write keeps on the server only in sealFields, which reads the switch', () => {
    const decides = (l: string) => /\bwrittenForms\(/.test(l);
    // put back reads it only to tell whether a context note is plain.
    expect(where(FUNCTIONS, decides)).toEqual(['mcp/note-text.ts', 'putback/firestore.ts']);
    const text = readFileSync(join(FUNCTIONS, 'mcp/note-text.ts'), 'utf8');
    const body = text.slice(text.indexOf('export async function sealFields('));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(
      /writtenForms\(forms, [^)]*codec\.sealingOn\(\)/,
    );
  });

  it('builds every codec with the gardener’s switch', () => {
    const built = sources(FUNCTIONS).flatMap(
      (f) =>
        code(join(FUNCTIONS, f))
          .join('\n')
          .match(/new NoteCodec\([^;]*?\)\)?[,;)]/g)
          ?.map((m) => `${f}: ${m.replace(/\s+/g, ' ')}`) ?? [],
    );
    expect(built.length).toBeGreaterThan(5);
    expect(built.filter((b) => !/sealingIn\(|sealing \?\? sealingIn\(/.test(b))).toEqual([]);
  });

  it('writes every NotesTools note through writeNote with forms that went by the switch', () => {
    const tools = code(join(FUNCTIONS, 'mcp/tools.ts')).join('\n');
    const calls = [...tools.matchAll(/this\.writeNote\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(20);
    // The last argument: a read note's forms, a made note's, or newForms().
    const last = (args: string) =>
      args
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
        .at(-1)!;
    const allowed = /^(?:\w+!?\.forms|w\.snap\.forms|forms|pieceForms|await this\.newForms\(\))$/;
    expect(calls.map(last).filter((a) => !allowed.test(a))).toEqual([]);
    // What it is for: a writer choosing plain itself is caught.
    for (const planted of ['PLAIN', 'PLAIN_FORMS', 'formsFound(d)', 'SEALED_FORMS'])
      expect(allowed.test(planted)).toBe(false);
  });

  it('writes no note document directly with note text, but through sealFields', () => {
    const flagged = sources(FUNCTIONS).flatMap((f) =>
      directNoteWrites(readFileSync(join(FUNCTIONS, f), 'utf8')).map((l) => `${f}: ${l}`),
    );
    expect(flagged).toEqual([]);
    // What it is for: the writes that slipped past it before are caught.
    const planted = [
      // The put back's context note, made with no form decided (review on #276).
      `async function f(tx: Transaction, ref: DocumentReference) {\n  tx.create(\n    ref,\n    Note.parse({ kind: 'context', body, title: 'Context for Claude' }),\n  );\n}`,
      `const ref = db.doc(paths.note(uid, id));\nawait ref.update({ title, titleSource: 'llm' });`,
      `const update: Data = { updatedAt: now };\nupdate['body'] = next;\ntx.update(this.notes().doc(id), update);`,
      `batch.set(notesCol.doc(id), { ...base, instructions: text });`,
    ];
    for (const p of planted) expect(directNoteWrites(p), p).not.toEqual([]);
    // And what it lets through: sealed writes, and writes with no note text.
    const fine = [
      `tx.update(ref, await sealFields(codec, ref.id, update, snap.forms));`,
      `const ref = db.doc(paths.note(uid, id));\nawait ref.update({ archived: true, sendAsk: FieldValue.delete() });`,
      `const out = await sealFields(this.codec, ref.id, data, forms);\nwriter.set(ref, out);`,
      `batch.update(feedRef, { noteId: id, title: 'x' });`,
    ];
    for (const p of fine) expect(directNoteWrites(p), p).toEqual([]);
  });

  it('seals note text in the app only at the write seam and its kept writes', () => {
    const raw = (l: string) => /\bsealText\(/.test(l);
    expect(where(FRONTEND, raw)).toEqual(['app/notes/notes.service.ts']);
    const decides = (l: string) => /\bwrittenForms\(/.test(l);
    expect(where(FRONTEND, decides)).toEqual(['app/notes/notes.service.ts']);
    const service = readFileSync(join(FRONTEND, 'app/notes/notes.service.ts'), 'utf8');
    // Every NotesService write goes through the seam that seals it.
    expect(service).toMatch(
      /private readonly api = refusingLocked\(\s*sealingNotes\(inject\(NOTES_API\)/,
    );
    expect(service.match(/inject\(NOTES_API\)/g)).toHaveLength(1);
    // The seam goes by the switch.
    const seam = service.slice(service.indexOf('  private sealWrite('));
    const body = seam.slice(0, seam.indexOf('\n  }\n'));
    expect(body).toContain('this.sealing.on()');
    expect(body).toMatch(/writtenForms\(formsFound\(this\.storedDoc\(id\)\), on\)/);
  });

  it('writes no note document in the app but through NotesService', () => {
    const notePath = (l: string) => /paths\.note\(|paths\.notes\(/.test(l);
    const writes = (l: string) =>
      /\b(?:setDoc|updateDoc|addDoc|writeBatch|runTransaction)\(/.test(l);
    const both = sources(FRONTEND).filter((f) => {
      const lines = code(join(FRONTEND, f));
      return lines.some(notePath) && lines.some(writes);
    });
    expect(both).toEqual(['app/notes/notes.service.ts']);
  });
});
