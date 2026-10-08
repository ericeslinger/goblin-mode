import { describe, expect, it } from 'vitest';
import { isDeclared, sniffType } from './sniff';

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );

describe('sniffType', () => {
  it('knows the kinds of file the app keeps by their first bytes', () => {
    expect(sniffType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffType(bytes([0x89], 'PNG\r\n'))).toBe('image/png');
    expect(sniffType(bytes('GIF89a'))).toBe('image/gif');
    expect(sniffType(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(bytes([0, 0, 0, 24], 'ftypheic'))).toBe('image/heic');
    expect(sniffType(bytes([0, 0, 0, 24], 'ftypmif1'))).toBe('image/heif');
    expect(sniffType(bytes('%PDF-1.7'))).toBe('application/pdf');
  });

  it('knows nothing else', () => {
    expect(sniffType(bytes('<html><script>'))).toBeUndefined();
    expect(sniffType(bytes('<svg xmlns='))).toBeUndefined();
    expect(sniffType(bytes([0, 0, 0, 24], 'ftypmp42'))).toBeUndefined();
    expect(sniffType(new Uint8Array())).toBeUndefined();
  });
});

describe('isDeclared', () => {
  it('matches the bytes to the declared type, HEIC and HEIF as one', () => {
    const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0]);
    expect(isDeclared(jpeg, 'image/jpeg')).toBe(true);
    expect(isDeclared(jpeg, 'image/png')).toBe(false);
    expect(isDeclared(bytes('<html>'), 'image/jpeg')).toBe(false);
    expect(isDeclared(bytes([0, 0, 0, 24], 'ftypmif1'), 'image/heic')).toBe(true);
    expect(isDeclared(jpeg, undefined)).toBe(false);
  });
});
