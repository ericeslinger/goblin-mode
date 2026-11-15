import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Keyed hashes (2026-11-14): a hash of a note's text is stored or
// matched only through the helpers that key it for a sealed note
// (packages/schema/src/text-hash.ts): on the server through NoteCodec
// (`hashText`, `hashMatcher`, `itemHash`), in the app through
// `noteTextHash` and `noteTextHashMatches` where the key is at hand.
// This reads the functions' and the app's source and fails on a bare
// `textHash(`, or a hash of text made some other way, outside them. A
// guard, not a proof; the sealed specs check what each site stores.

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
  sources(root).filter((f) => code(join(root, f)).some(test));

/** The schema's helpers, called only where the key comes from. */
const HELPERS = /\b(?:noteTextHash|noteTextHashMatches|itemHash|refileNamesHash)\(/;

describe('the hash boundary', () => {
  it('names the plain textHash nowhere in the functions or the app', () => {
    const bare = (l: string) => /\btextHash\b/.test(l);
    expect(where(FUNCTIONS, bare)).toEqual([]);
    expect(where(FRONTEND, bare)).toEqual([]);
  });

  it('calls the schema’s hash helpers on the server only in the codec', () => {
    // `codec.itemHash(` and `this.codec.hashText(` are the codec's own.
    const helper = (l: string) => HELPERS.test(l.replace(/\.(?:itemHash)\(/g, '.x('));
    expect(where(FUNCTIONS, helper)).toEqual(['mcp/note-text.ts']);
  });

  it('calls them in the app only where a note’s key is at hand', () => {
    expect(where(FRONTEND, (l) => HELPERS.test(l)).sort()).toEqual([
      'app/claude/run-changes.ts',
      'app/notes/notes.service.ts',
    ]);
  });

  it('makes no hash of text some other way, outside the places that hash secrets', () => {
    const hashing = (l: string) => /\bcreateH(?:ash|mac)\(|subtle\.digest\(/.test(l);
    // OAuth codes and tokens, and the local key sealer's secret: no note text.
    expect(where(FUNCTIONS, hashing).sort()).toEqual(['keys/local-sealer.ts', 'oauth/core.ts']);
    expect(where(FRONTEND, hashing)).toEqual([]);
  });
});
