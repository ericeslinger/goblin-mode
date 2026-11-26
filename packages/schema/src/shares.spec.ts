import { describe, expect, it } from 'vitest';
import { Share, autoId } from './index';
import {
  SHARE_ID_LENGTH,
  SHARE_ID_PATTERN,
  isShareId,
  newShareId,
  shareKindOf,
  shareSource,
} from './shares';

const random = (bytes: Uint8Array<ArrayBuffer>) => void crypto.getRandomValues(bytes);
/** The platform's base64url of `bytes`, to check the share id against. */
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

describe('newShareId', () => {
  it('is 32 characters of base64url, from 24 random bytes', () => {
    const id = newShareId(random);
    expect(id).toHaveLength(SHARE_ID_LENGTH);
    expect(id).toMatch(SHARE_ID_PATTERN);
    expect(isShareId(id)).toBe(true);
  });

  it('spells the bytes it is given as base64url, with no padding', () => {
    // 0xfb is 111110 11..., so "-" and "_" in turn.
    const fill = (bytes: Uint8Array) => bytes.fill(0xfb);
    expect(newShareId(fill)).toMatch(/^[-+_/=A-Za-z0-9]{32}$/);
    expect(newShareId(fill)).toBe(base64url(new Uint8Array(24).fill(0xfb)));
    const zero = (bytes: Uint8Array) => bytes.fill(0);
    expect(newShareId(zero)).toBe('A'.repeat(32));
    // The same as the platform's own base64url of the same bytes.
    const bytes = new Uint8Array(24).map((_, i) => i * 11 + 3);
    const id = newShareId((b) => b.set(bytes));
    const expected = base64url(bytes);
    expect(id).toBe(expected);
  });

  it('carries 192 bits: never two alike, and every character used', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = newShareId(random);
      seen.add(id);
      for (const c of id) chars.add(c);
    }
    expect(seen.size).toBe(2000);
    expect(chars.size).toBe(64);
  });

  it('draws again rather than make an id Firestore keeps for itself', () => {
    let n = 0;
    const fill = (bytes: Uint8Array) => {
      // First draw: "__" ... "__" (0xff bytes spell underscores).
      bytes.fill(n++ === 0 ? 0xff : 0x41);
    };
    const id = newShareId(fill);
    expect(id).not.toMatch(/^__.*__$/);
    expect(n).toBe(2);
  });

  it('is not the auto id shape, which carries about 119 bits', () => {
    const auto = autoId(random);
    expect(isShareId(auto)).toBe(false);
    expect(20 * Math.log2(62)).toBeLessThan(128);
    expect(newShareId(random).length * 6).toBeGreaterThanOrEqual(128);
  });
});

describe('isShareId', () => {
  it('refuses any other shape before anything is fetched', () => {
    for (const bad of [
      '',
      'short',
      'A'.repeat(31),
      'A'.repeat(33),
      `${'A'.repeat(31)}.`,
      `${'A'.repeat(31)}/`,
      `${'A'.repeat(30)}%2`,
      `${'A'.repeat(31)}\n`,
      undefined,
      42,
    ]) {
      expect(isShareId(bad)).toBe(false);
    }
  });
});

describe('shareKindOf', () => {
  it('shares plain notes and recipes, nothing else', () => {
    expect(shareKindOf('text')).toBe('note');
    expect(shareKindOf('recipe')).toBe('recipe');
    for (const kind of ['concept', 'template', 'context', 'mealplan', 'pantry', 'clipping']) {
      expect(shareKindOf(kind)).toBeUndefined();
    }
  });
});

describe('shareSource', () => {
  it('keeps an http or https link, nothing else', () => {
    expect(shareSource('https://recipes.example/gratin')).toBe('https://recipes.example/gratin');
    expect(shareSource('http://recipes.example/')).toBe('http://recipes.example/');
    expect(shareSource('javascript:alert(1)')).toBeUndefined();
    expect(shareSource('data:text/html,x')).toBeUndefined();
    expect(shareSource('not a link')).toBeUndefined();
    expect(shareSource(undefined)).toBeUndefined();
    expect(shareSource(`https://x.example/${'a'.repeat(5000)}`)).toBeUndefined();
  });
});

describe('Share', () => {
  const at = { seconds: 1, nanoseconds: 0 };
  const base = {
    owner: 'u1',
    noteId: 'n1',
    kind: 'note',
    title: 'Glaze',
    body: 'Two parts',
    sharedAt: at,
    updatedAt: at,
  };

  it('holds the copy and nothing more', () => {
    expect(Share.parse(base)).toEqual(base);
    // Anything else of the note is dropped, never stored.
    expect(Share.parse({ ...base, tags: ['x'], links: ['n2'] })).toEqual(base);
    expect(Share.safeParse({ ...base, kind: 'concept' }).success).toBe(false);
    expect(Share.safeParse({ ...base, title: 'x'.repeat(1001) }).success).toBe(false);
    expect(Share.safeParse({ ...base, body: 'x'.repeat(200_001) }).success).toBe(false);
  });
});
