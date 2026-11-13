import { describe, expect, it } from 'vitest';
import {
  aadFor,
  DataKey,
  exportDataKey,
  importDataKey,
  isSealed,
  isSealedListField,
  newDataKey,
  openSealedText,
  openText,
  recordAadFor,
  SEAL_SENTINEL,
  SEALED_RECORD_FIELDS,
  SEALED_FIELDS,
  SealError,
  sealText,
  versionedAad,
} from './sealed';

const key = newDataKey();
const body = aadFor('uid-1', 'note-1', 'body');
const title = aadFor('uid-1', 'note-1', 'title');

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof SealError) return e.code;
    throw e;
  }
  return undefined;
}

const PREFIX = `${SEAL_SENTINEL}mg1.`;

/** The bytes after the prefix, decoded with the platform's own base64. */
function payload(sealed: string): Uint8Array<ArrayBuffer> {
  const b64 = sealed.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** A sealed value from raw bytes, encoded with the platform's own base64. */
function sealedFrom(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return PREFIX + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Flips one bit of the sealed bytes and re-encodes, keeping the prefix. */
function tamper(sealed: string, byte: number): string {
  const bytes = payload(sealed);
  bytes[byte] ^= 1;
  return sealedFrom(bytes);
}

describe('sealText and openText', () => {
  it('round-trips text', () => {
    const sealed = sealText(key, body, 'Buy *moss* for the terrarium');
    expect(isSealed(sealed)).toBe(true);
    expect(sealed.startsWith('\uE000mg1.')).toBe(true);
    expect(sealed).not.toContain('moss');
    expect(openText(key, body, sealed)).toBe('Buy *moss* for the terrarium');
  });

  it('round-trips unicode and the empty string', () => {
    for (const text of [
      '',
      'é',
      '🍄 goblin 🌿',
      '日本語のメモ',
      'a\u0000b',
      '\uE000 not a seal',
      'x'.repeat(20_000),
    ]) {
      expect(openText(key, body, sealText(key, body, text))).toBe(text);
    }
  });

  it('uses a fresh nonce on every seal', () => {
    const a = sealText(key, body, 'same words');
    const b = sealText(key, body, 'same words');
    expect(a).not.toBe(b);
    expect(a.slice(5, 21)).not.toBe(b.slice(5, 21));
  });

  it('refuses tampered nonce, ciphertext and tag', () => {
    const sealed = sealText(key, body, 'do not change me');
    const len = payload(sealed).length;
    for (const byte of [0, 11, 12, len - 17, len - 1]) {
      expect(code(() => openText(key, body, tamper(sealed, byte)))).toBe('failed');
    }
  });

  it('refuses the wrong key, uid, note id and field', () => {
    const sealed = sealText(key, body, 'private');
    expect(code(() => openText(newDataKey(), body, sealed))).toBe('failed');
    expect(code(() => openText(key, aadFor('uid-2', 'note-1', 'body'), sealed))).toBe('failed');
    expect(code(() => openText(key, aadFor('uid-1', 'note-2', 'body'), sealed))).toBe('failed');
    expect(code(() => openText(key, title, sealed))).toBe('failed');
  });

  it('cannot swap the title and body of one note', () => {
    const t = sealText(key, title, 'A title');
    const b = sealText(key, body, 'A body');
    expect(code(() => openText(key, body, t))).toBe('failed');
    expect(code(() => openText(key, title, b))).toBe('failed');
  });

  it('keeps aad parts from running into each other', () => {
    const sealed = sealText(key, aadFor('ab', 'c', 'body'), 'x');
    expect(code(() => openText(key, aadFor('a', 'bc', 'body'), sealed))).toBe('failed');
  });

  it('throws on values that look sealed but are malformed', () => {
    const p = '\uE000mg1.';
    expect(code(() => openText(key, body, p))).toBe('malformed');
    expect(code(() => openText(key, body, `${p}abc`))).toBe('malformed');
    expect(code(() => openText(key, body, `${p}${'A'.repeat(40)}!`))).toBe('malformed');
    expect(code(() => openText(key, body, `${p}${'A'.repeat(37)}`))).toBe('malformed');
    expect(code(() => openText(key, body, `${p}${'A'.repeat(41)}B`))).toBe('malformed');
    const sealed = sealText(key, body, 'whole');
    expect(code(() => openText(key, body, sealed.slice(0, -8)))).toBe('malformed');
    const longer = sealText(key, body, 'a longer text to cut short');
    expect(code(() => openText(key, body, longer.slice(0, -4)))).toBe('failed');
    expect(code(() => openText(key, body, `${sealed}==`))).toBe('malformed');
    expect(code(() => openText(key, body, `${sealed} `))).toBe('malformed');
  });

  it('throws on an unknown version', () => {
    const sealed = sealText(key, body, 'v1');
    expect(code(() => openText(key, body, sealed.replace('mg1.', 'mg2.')))).toBe('unknown-version');
    expect(code(() => openText(key, body, sealed.replace('mg1.', 'mg10.')))).toBe(
      'unknown-version',
    );
  });

  it('passes plain text through unchanged', () => {
    for (const text of [
      '',
      'plain',
      'mg1.AAAA',
      ' \uE000mg1.AAAA',
      '\uE000',
      '\uE000mg.',
      '\uE000hello',
    ]) {
      expect(isSealed(text)).toBe(false);
      expect(openText(key, body, text)).toBe(text);
    }
  });

  it('will not seal a sealed value again', () => {
    const sealed = sealText(key, body, 'once');
    expect(code(() => sealText(key, body, sealed))).toBe('already-sealed');
    expect(code(() => sealText(key, body, '\uE000mg9.anything'))).toBe('already-sealed');
    expect(sealText(key, body, openText(key, body, sealed))).not.toBe(sealed);
  });

  it('binds the version tag, so the same bytes under another tag do not open (review on #260)', async () => {
    const raw = exportDataKey(key);
    const ck = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    // Sealed without the tag in its authenticated data, as before the review.
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: body },
        ck,
        new TextEncoder().encode('untagged'),
      ),
    );
    expect(code(() => openText(key, body, sealedFrom(new Uint8Array([...nonce, ...ct]))))).toBe(
      'failed',
    );
  });

  it('openSealedText refuses plain text, and opens sealed text as openText does', () => {
    expect(code(() => openSealedText(key, body, 'plain'))).toBe('not-sealed');
    expect(openSealedText(key, body, sealText(key, body, 'kept'))).toBe('kept');
  });

  it('opens a history copy of a body with the note aad', () => {
    // The aad names uid, note and field, never the path, so text copied
    // to notes/{id}/history/{v} opens as it is.
    const live = sealText(key, aadFor('uid-1', 'note-1', 'body'), 'kept');
    const copy = live;
    expect(openText(key, aadFor('uid-1', 'note-1', 'body'), copy)).toBe('kept');
  });

  it('is standard AES-256-GCM that WebCrypto can open', async () => {
    const raw = exportDataKey(key);
    const sealed = sealText(key, body, 'interop ✓');
    const bytes = payload(sealed);
    const ck = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt', 'encrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: versionedAad(body) },
      ck,
      bytes.subarray(12),
    );
    expect(new TextDecoder().decode(plain)).toBe('interop ✓');

    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: versionedAad(body) },
        ck,
        new TextEncoder().encode('from webcrypto'),
      ),
    );
    const theirs = sealedFrom(new Uint8Array([...nonce, ...ct]));
    expect(openText(key, body, theirs)).toBe('from webcrypto');
  });
});

describe('data keys', () => {
  it('exports and imports 32 raw bytes', () => {
    const raw = exportDataKey(key);
    expect(raw).toHaveLength(32);
    const again = importDataKey(raw);
    raw.fill(0);
    expect(openText(again, body, sealText(key, body, 'same key'))).toBe('same key');
    expect(exportDataKey(again)).not.toEqual(raw);
  });

  it('refuses keys of the wrong length', () => {
    expect(() => importDataKey(new Uint8Array(16))).toThrow(RangeError);
    expect(() => importDataKey(new Uint8Array(33))).toThrow(RangeError);
  });

  it('makes a different key each time', () => {
    expect(exportDataKey(newDataKey())).not.toEqual(exportDataKey(newDataKey()));
  });

  it('is only made by newDataKey and importDataKey', () => {
    expect(() => sealText(new DataKey(), body, 'x')).toThrow(TypeError);
  });

  it('never prints its bytes', () => {
    expect(String(key)).toBe('[DataKey]');
    expect(JSON.stringify({ key })).toBe('{"key":"[DataKey]"}');
  });
});

describe('aadFor', () => {
  it('needs a uid, a note id and a sealed field', () => {
    expect(() => aadFor('', 'n', 'body')).toThrow(RangeError);
    expect(() => aadFor('u', '', 'body')).toThrow(RangeError);
    expect(() => aadFor('u', 'n', 'tags' as 'body')).toThrow(RangeError);
  });
});

describe('the other text fields of a note (step 3d, 2026-11-13)', () => {
  const fields = [
    'synonyms',
    'instructions',
    'sendAsk',
    'sendOutcome',
    'importError',
    'source.text',
  ] as const;

  it('are sealed fields, each with an aad of its own', () => {
    for (const field of fields) expect(SEALED_FIELDS).toContain(field);
    const aads = SEALED_FIELDS.map((f) => [...aadFor('uid-1', 'note-1', f)].join(','));
    expect(new Set(aads).size).toBe(SEALED_FIELDS.length);
  });

  it('round-trip under their own field, and open under no other', () => {
    for (const field of fields) {
      const sealed = sealText(key, aadFor('uid-1', 'note-1', field), `words for ${field}`);
      expect(openText(key, aadFor('uid-1', 'note-1', field), sealed)).toBe(`words for ${field}`);
      for (const other of SEALED_FIELDS.filter((f) => f !== field)) {
        expect(code(() => openText(key, aadFor('uid-1', 'note-1', other), sealed))).toBe('failed');
      }
    }
  });

  it('binds the nested source text by its path', () => {
    const sealed = sealText(key, aadFor('uid-1', 'note-1', 'source.text'), 'the page');
    expect(code(() => openText(key, aadFor('uid-1', 'note-1', 'body'), sealed))).toBe('failed');
    expect(() => aadFor('uid-1', 'note-1', 'source' as 'body')).toThrow(RangeError);
    expect(() => aadFor('uid-1', 'note-1', 'text' as 'body')).toThrow(RangeError);
  });

  it('seals a list element by element, each bound to the field, not its place', () => {
    const aad = aadFor('uid-1', 'note-1', 'synonyms');
    expect(isSealedListField('synonyms')).toBe(true);
    expect(isSealedListField('instructions')).toBe(false);
    const names = ['Moss', 'The goblin', 'MG'].map((n) => sealText(key, aad, n));
    // Reordered, or with a name taken out, the list still opens.
    const reordered = [names[2], names[0]];
    expect(reordered.map((v) => openText(key, aad, v))).toEqual(['MG', 'Moss']);
  });

  it('will not open a list element moved to another note, field or user', () => {
    const element = sealText(key, aadFor('uid-1', 'note-1', 'synonyms'), 'Moss');
    expect(code(() => openText(key, aadFor('uid-1', 'note-2', 'synonyms'), element))).toBe(
      'failed',
    );
    expect(code(() => openText(key, aadFor('uid-2', 'note-1', 'synonyms'), element))).toBe(
      'failed',
    );
    for (const other of ['title', 'body', 'instructions'] as const) {
      expect(code(() => openText(key, aadFor('uid-1', 'note-1', other), element))).toBe('failed');
    }
  });
});

describe('fields of records about notes (step 3e, 2026-11-13)', () => {
  const aad = recordAadFor('uid-1', 'proposals', 'prop-1', 'title');

  it('round-trip under their own user, collection, document and field', () => {
    const sealed = sealText(key, aad, 'Moss and goblins');
    expect(sealed.startsWith(PREFIX)).toBe(true);
    expect(openText(key, recordAadFor('uid-1', 'proposals', 'prop-1', 'title'), sealed)).toBe(
      'Moss and goblins',
    );
  });

  it('do not open under another user, collection, document or field', () => {
    const sealed = sealText(key, recordAadFor('uid-1', 'runs', 'run-1', 'outcome'), 'Filed it');
    const wrong = [
      recordAadFor('uid-2', 'runs', 'run-1', 'outcome'),
      recordAadFor('uid-1', 'runs', 'run-2', 'outcome'),
      recordAadFor('uid-1', 'runs', 'run-1', 'itemText'),
      // The same document id and a field of the same name elsewhere.
      recordAadFor('uid-1', 'proposals', 'run-1', 'title'),
    ];
    for (const other of wrong) expect(code(() => openText(key, other, sealed))).toBe('failed');
    const reason = sealText(key, recordAadFor('uid-1', 'proposals', 'p', 'reason'), 'Because');
    expect(
      code(() => openText(key, recordAadFor('uid-1', 'proposals', 'p', 'title'), reason)),
    ).toBe('failed');
  });

  it('never open as a note field, nor a note field as one of them', () => {
    // A note and a record with the same id, and a field of the same name.
    const asRecord = sealText(key, recordAadFor('uid-1', 'proposals', 'n1', 'title'), 'Moss');
    const asNote = sealText(key, aadFor('uid-1', 'n1', 'title'), 'Moss');
    expect(code(() => openText(key, aadFor('uid-1', 'n1', 'title'), asRecord))).toBe('failed');
    for (const [collection, fields] of Object.entries(SEALED_RECORD_FIELDS)) {
      for (const field of fields) {
        const at = recordAadFor('uid-1', collection as 'runs', 'n1', field as 'outcome');
        expect(code(() => openText(key, at, asNote))).toBe('failed');
      }
    }
  });

  it("have an aad unlike any note field's", () => {
    const notes = new Set(SEALED_FIELDS.map((f) => [...aadFor('uid-1', 'n1', f)].join(',')));
    const records = Object.entries(SEALED_RECORD_FIELDS).flatMap(([c, fields]) =>
      fields.map((f) => [...recordAadFor('uid-1', c as 'runs', 'n1', f as 'outcome')].join(',')),
    );
    expect(new Set(records).size).toBe(records.length);
    for (const r of records) expect(notes.has(r)).toBe(false);
  });

  it('need a uid, a document id, a known collection and one of its fields', () => {
    expect(() => recordAadFor('', 'runs', 'r', 'outcome')).toThrow(RangeError);
    expect(() => recordAadFor('u', 'runs', '', 'outcome')).toThrow(RangeError);
    expect(() => recordAadFor('u', 'notes' as 'runs', 'r', 'outcome')).toThrow(RangeError);
    expect(() => recordAadFor('u', 'toString' as 'runs', 'r', 'outcome')).toThrow(RangeError);
    expect(() => recordAadFor('u', 'runs', 'r', 'title' as 'outcome')).toThrow(RangeError);
    expect(() => recordAadFor('u', 'proposals', 'r', 'outcome' as 'title')).toThrow(RangeError);
  });
});
