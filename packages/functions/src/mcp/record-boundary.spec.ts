import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Note encryption step 3e (2026-11-13): the text of records about notes
// may be sealed (SEALED_RECORD_FIELDS): a run's item text, item key and
// outcome, a suggestion's proposed title and reason. This reads the
// functions' source and fails where one is read raw outside the few
// places that open or seal it. A guard, not a proof; the sealed specs
// beside each store check what the paths do.

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sources(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [relative(ROOT, path)] : [];
  });
}
const sourceOf = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const code = (source: string) => source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));

/**
 * Where a run's item text and key may be named: written sealed
 * (assigned.ts), opened as claimed (firestore-store.ts), and used once
 * opened (items.ts, the record's type in core.ts).
 */
const ITEM_SITES = [
  'agent/assigned.ts',
  'agent/firestore-store.ts',
  'agent/items.ts',
  'agent/core.ts',
];

describe('the record text boundary in the functions', () => {
  it('names a run’s item text and key only where they are sealed or opened', () => {
    const outside = sources()
      .filter((f) => !ITEM_SITES.includes(f))
      .filter((f) => code(sourceOf(f)).some((l) => /\bitem(?:Key|Text)\b/.test(l)));
    expect(outside).toEqual([]);
  });

  it('reads a stored run’s item text and key in the run store only to open them or tell their form', () => {
    const raw = code(sourceOf('agent/firestore-store.ts')).filter(
      (l) =>
        /\[\s*'item(?:Key|Text)'\s*\]|\.item(?:Key|Text)\b/.test(l) &&
        // Told its form, or left out when it did not open.
        !/isSealed\(|^\s*delete out\[/.test(l),
    );
    expect(raw).toEqual([]);
  });

  it('opens a suggestion’s proposed title before it is used', () => {
    const uses = code(sourceOf('organize/apply.ts')).filter((l) =>
      /\bp\.(?:title|reason)\b/.test(l),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).toMatch(/openRecord\(|=== undefined/);
  });

  it('stores a run outcome through the run store, which seals it', () => {
    // Every writer of a run's outcome goes through RunStore.update.
    const direct = sources()
      .filter((f) => f !== 'agent/firestore-store.ts')
      .filter((f) => /paths\.run\(/.test(sourceOf(f)))
      .filter((f) => code(sourceOf(f)).some((l) => /\boutcome\s*:/.test(l)));
    expect(direct).toEqual([]);
  });
});
