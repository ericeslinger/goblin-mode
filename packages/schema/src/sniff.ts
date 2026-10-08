// What a file's first bytes say it is (#44). Storage rules can only
// check the type an upload declares, so the bytes are checked here, and
// a file that is not what it says is removed (review on #43).

/** How many leading bytes `sniffType` needs. */
export const SNIFF_BYTES = 16;

const ascii = (bytes: Uint8Array, from: number, text: string) =>
  [...text].every((c, i) => bytes[from + i] === c.charCodeAt(0));

/** The media type the bytes are, among those the app keeps, if any. */
export function sniffType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && ascii(bytes, 1, 'PNG')) return 'image/png';
  if (ascii(bytes, 0, 'GIF8')) return 'image/gif';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  if (ascii(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
  }
  if (ascii(bytes, 0, '%PDF-')) return 'application/pdf';
  return undefined;
}

/**
 * Whether the bytes are the kind of file the upload declared. HEIC and
 * HEIF are one family (phones label either way).
 */
export function isDeclared(bytes: Uint8Array, declared: string | undefined): boolean {
  const sniffed = sniffType(bytes);
  if (!sniffed || !declared) return false;
  const family = (t: string) => (t === 'image/heif' ? 'image/heic' : t);
  return family(sniffed) === family(declared);
}
