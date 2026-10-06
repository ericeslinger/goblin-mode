const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A 20-character id in the same alphabet Firestore uses for auto ids,
 * made on the device so a note exists the moment it is created, offline
 * and before sign-in. `fill` fills a byte array with random bytes in
 * place (crypto.getRandomValues in the app).
 */
export function autoId(fill: (bytes: Uint8Array<ArrayBuffer>) => void): string {
  const bytes = new Uint8Array(20);
  fill(bytes);
  let id = '';
  // 248 is the largest multiple of 62 below 256: reject bytes above it so
  // every character is equally likely.
  for (let i = 0; id.length < 20; i++) {
    if (i >= bytes.length) {
      fill(bytes);
      i = 0;
    }
    if (bytes[i] < 248) id += ALPHABET[bytes[i] % 62];
  }
  return id;
}
