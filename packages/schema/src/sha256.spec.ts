import { describe, expect, it } from 'vitest';
import { hkdfSha256, hmacSha256, sha256, toHex } from './sha256';

// Checked against the RFC vectors and against WebCrypto, which has all
// three, but only async (why sha256.ts exists).

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const utf8 = (s: string) => new TextEncoder().encode(s);
const bytes = (n: number, seed = 7) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

const subtle = globalThis.crypto.subtle;
const webSha256 = async (data: Uint8Array) =>
  toHex(new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(data))));
async function webHmac(key: Uint8Array, msg: Uint8Array) {
  const k = await subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(new Uint8Array(await subtle.sign('HMAC', k, new Uint8Array(msg))));
}
async function webHkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const k = await subtle.importKey('raw', new Uint8Array(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: new Uint8Array(info) },
    k,
    length * 8,
  );
  return toHex(new Uint8Array(bits));
}

describe('sha256', () => {
  it('agrees with WebCrypto at every length around the block edges', async () => {
    for (let n = 0; n <= 200; n++) {
      const data = bytes(n);
      expect(toHex(sha256(data))).toBe(await webSha256(data));
    }
    const big = bytes(100_003);
    expect(toHex(sha256(big))).toBe(await webSha256(big));
  });

  it('gives the FIPS 180 example digest', () => {
    expect(toHex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('hmacSha256', () => {
  it('gives the RFC 4231 vectors', () => {
    // Test case 1.
    expect(toHex(hmacSha256(hex('0b'.repeat(20)), utf8('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
    // Test case 6: a key longer than a block is hashed first.
    expect(
      toHex(
        hmacSha256(
          hex('aa'.repeat(131)),
          utf8('Test Using Larger Than Block-Size Key - Hash Key First'),
        ),
      ),
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });

  it('agrees with WebCrypto for keys and messages of many lengths', async () => {
    for (const k of [1, 32, 63, 64, 65, 200]) {
      for (const m of [0, 1, 55, 64, 1000]) {
        const key = bytes(k, 3);
        const msg = bytes(m, 11);
        expect(toHex(hmacSha256(key, msg))).toBe(await webHmac(key, msg));
      }
    }
  });
});

describe('hkdfSha256', () => {
  it('gives the RFC 5869 vectors', () => {
    // Test case 1.
    expect(
      toHex(
        hkdfSha256(
          hex('0b'.repeat(22)),
          hex('000102030405060708090a0b0c'),
          hex('f0f1f2f3f4f5f6f7f8f9'),
          42,
        ),
      ),
    ).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
    // Test case 3: no salt, no info.
    expect(toHex(hkdfSha256(hex('0b'.repeat(22)), new Uint8Array(0), new Uint8Array(0), 42))).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });

  it('agrees with WebCrypto', async () => {
    const ikm = bytes(32, 5);
    const info = bytes(40, 9);
    for (const length of [1, 32, 33, 64, 100]) {
      expect(toHex(hkdfSha256(ikm, new Uint8Array(0), info, length))).toBe(
        await webHkdf(ikm, new Uint8Array(0), info, length),
      );
    }
  });
});
