import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { THUMB_SIZE, type UploadStore, placeOf, processUpload, thumbPathFor } from './process';
import { sharpThumbnail } from './storage-store';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');
const PATH = 'users/u1/attachments/a1/menu.jpg';

function store(file: Uint8Array) {
  return {
    head: vi.fn(async (_p: string, n: number) => file.slice(0, n)),
    read: vi.fn(async () => file),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    setThumb: vi.fn(async () => undefined),
  } satisfies UploadStore;
}

describe('processUpload', () => {
  it('gives a photo a thumbnail beside it, named on its record', async () => {
    const s = store(JPEG);
    const thumb = vi.fn(async () => Uint8Array.from([1, 2, 3]));
    expect(await processUpload(s, thumb, PATH, 'image/jpeg')).toBe('thumbnailed');
    const thumbPath = 'users/u1/attachments/a1/thumb_menu.webp';
    expect(s.write).toHaveBeenCalledWith(thumbPath, Uint8Array.from([1, 2, 3]), 'image/webp');
    expect(s.setThumb).toHaveBeenCalledWith('u1', 'a1', thumbPath);
    expect(s.remove).not.toHaveBeenCalled();
  });

  it('removes a file whose bytes are not what it declared', async () => {
    const s = store(HTML);
    const warn = vi.fn();
    expect(await processUpload(s, vi.fn(), PATH, 'image/jpeg', warn)).toBe('removed');
    expect(s.remove).toHaveBeenCalledWith(PATH);
    expect(s.write).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps a photo it cannot shrink (HEIC), and a PDF without one', async () => {
    const s = store(JPEG);
    const failing = vi.fn(async () => {
      throw new Error('heif: unsupported');
    });
    expect(await processUpload(s, failing, PATH, 'image/jpeg')).toBe('kept');
    expect(s.setThumb).not.toHaveBeenCalled();
    const pdf = store(new TextEncoder().encode('%PDF-1.7 and more bytes'));
    expect(
      await processUpload(pdf, vi.fn(), 'users/u1/attachments/a2/doc.pdf', 'application/pdf'),
    ).toBe('kept');
  });

  it('leaves alone its own thumbnails and files outside attachments', async () => {
    const s = store(JPEG);
    expect(
      await processUpload(s, vi.fn(), 'users/u1/attachments/a1/thumb_menu.webp', 'image/webp'),
    ).toBe('skipped');
    expect(await processUpload(s, vi.fn(), 'users/u1/other/x.jpg', 'image/jpeg')).toBe('skipped');
    expect(s.head).not.toHaveBeenCalled();
  });
});

describe('paths', () => {
  it('reads an attachment file path and names its thumbnail', () => {
    expect(placeOf(PATH)).toEqual({ uid: 'u1', id: 'a1', name: 'menu.jpg' });
    expect(placeOf('users/u1/attachments/a1/deep/x.jpg')).toBeUndefined();
    expect(thumbPathFor({ uid: 'u1', id: 'a1', name: 'IMG.HEIC' })).toBe(
      'users/u1/attachments/a1/thumb_IMG.webp',
    );
  });
});

describe('sharpThumbnail', () => {
  it('shrinks a photo to a WebP no larger than the thumbnail size', async () => {
    const big = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: '#c33' },
    })
      .jpeg()
      .toBuffer();
    const thumb = await sharpThumbnail(big);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(THUMB_SIZE);
    expect(meta.height).toBe(THUMB_SIZE / 2);
  });
});
