import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  TEXT_METADATA,
  THUMB_METADATA,
  THUMB_SIZE,
  type UploadStore,
  placeOf,
  processUpload,
  thumbPathFor,
} from './process';
import { pdfText, sharpThumbnail } from './storage-store';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new TextEncoder().encode('RIFF\u0001\u0002\u0003\u0004WEBPVP8 rest');
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');
const PATH = 'users/u1/attachments/a1/menu.jpg';

function store(file: Uint8Array) {
  return {
    head: vi.fn(async (_p: string, n: number) => file.slice(0, n)),
    read: vi.fn(async () => file),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    setContentType: vi.fn(async () => undefined),
    setThumb: vi.fn(async () => undefined),
    setText: vi.fn(async () => undefined),
    removeRecord: vi.fn(async () => undefined),
  } satisfies UploadStore;
}

describe('processUpload', () => {
  it('gives a photo a thumbnail beside it, named on its record', async () => {
    const s = store(JPEG);
    const thumb = vi.fn(async () => Uint8Array.from([1, 2, 3]));
    expect(await processUpload(s, thumb, PATH, 'image/jpeg', {})).toBe('thumbnailed');
    const thumbPath = 'users/u1/attachments/a1/thumb_menu.webp';
    expect(s.write).toHaveBeenCalledWith(
      thumbPath,
      Uint8Array.from([1, 2, 3]),
      'image/webp',
      THUMB_METADATA,
    );
    expect(s.setThumb).toHaveBeenCalledWith('u1', 'a1', thumbPath);
    expect(s.remove).not.toHaveBeenCalled();
    expect(s.setContentType).not.toHaveBeenCalled();
  });

  it('keeps a photo labelled by its name, not its bytes, and relabels it', async () => {
    // A WebP saved as menu.jpg: the browser calls it image/jpeg.
    const s = store(WEBP);
    const thumb = vi.fn(async () => Uint8Array.from([1]));
    expect(await processUpload(s, thumb, PATH, 'image/jpeg', {})).toBe('thumbnailed');
    expect(s.setContentType).toHaveBeenCalledWith(PATH, 'image/webp');
    expect(s.remove).not.toHaveBeenCalled();
    expect(s.removeRecord).not.toHaveBeenCalled();
  });

  it('removes a file that is no photo or PDF at all, with its record', async () => {
    const s = store(HTML);
    const warn = vi.fn();
    expect(await processUpload(s, vi.fn(), PATH, 'image/jpeg', {}, warn)).toBe('removed');
    expect(s.remove).toHaveBeenCalledWith(PATH);
    expect(s.removeRecord).toHaveBeenCalledWith('u1', 'a1');
    expect(s.write).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps a photo it cannot shrink (HEIC), and a PDF without one', async () => {
    const s = store(JPEG);
    const failing = vi.fn(async () => {
      throw new Error('heif: unsupported');
    });
    expect(await processUpload(s, failing, PATH, 'image/jpeg', {})).toBe('kept');
    expect(s.setThumb).not.toHaveBeenCalled();
    const pdf = store(new TextEncoder().encode('%PDF-1.7 and more bytes'));
    expect(
      await processUpload(pdf, vi.fn(), 'users/u1/attachments/a2/doc.pdf', 'application/pdf', {}),
    ).toBe('kept');
  });

  it('reads a PDF’s text into a file beside it, named on its record (#45)', async () => {
    const pdf = store(new TextEncoder().encode('%PDF-1.7 and more bytes'));
    const extract = vi.fn(async () => ({ text: 'Dinner\n\nDessert', pages: 2 }));
    const path = 'users/u1/attachments/a2/menu.pdf';
    expect(await processUpload(pdf, vi.fn(), path, 'application/pdf', {}, undefined, extract)).toBe(
      'texted',
    );
    const textPath = 'users/u1/attachments/a2/text_menu.txt';
    expect(pdf.write).toHaveBeenCalledWith(
      textPath,
      new TextEncoder().encode('Dinner\n\nDessert'),
      'text/plain; charset=utf-8',
      TEXT_METADATA,
    );
    expect(pdf.setText).toHaveBeenCalledWith('u1', 'a2', { textPath, pages: 2 });
    // One it cannot read is kept, without text.
    const unreadable = store(new TextEncoder().encode('%PDF-1.7 broken'));
    const failing = vi.fn(async () => {
      throw new Error('Invalid PDF structure');
    });
    expect(
      await processUpload(unreadable, vi.fn(), path, 'application/pdf', {}, undefined, failing),
    ).toBe('kept');
    expect(unreadable.setText).not.toHaveBeenCalled();
    // Its own text file is left alone.
    expect(await processUpload(pdf, vi.fn(), textPath, 'text/plain', TEXT_METADATA)).toBe(
      'skipped',
    );
  });

  it('leaves alone its own thumbnails and files outside attachments', async () => {
    const s = store(JPEG);
    const own = { mossgoblinThumbnail: 'true' };
    const thumbPath = 'users/u1/attachments/a1/thumb_menu.webp';
    expect(await processUpload(s, vi.fn(), thumbPath, 'image/webp', own)).toBe('skipped');
    expect(await processUpload(s, vi.fn(), 'users/u1/other/x.jpg', 'image/jpeg', {})).toBe(
      'skipped',
    );
    expect(s.head).not.toHaveBeenCalled();
  });

  it('checks an upload named like a thumbnail, which it did not write', async () => {
    const s = store(HTML);
    const path = 'users/u1/attachments/a1/thumb_x.jpg';
    expect(await processUpload(s, vi.fn(), path, 'image/jpeg', undefined)).toBe('removed');
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

describe('pdfText', () => {
  it('reads each page’s text', async () => {
    const page = (text: string) => `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
      `<< /Length ${page('Dinner menu').length} >>\nstream\n${page('Dinner menu')}\nendstream`,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
      `<< /Length ${page('Dessert').length} >>\nstream\n${page('Dessert')}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((o, i) => {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) body += `${String(o).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const { text, pages } = await pdfText(new TextEncoder().encode(body));
    expect(pages).toBe(2);
    expect(text).toBe('Dinner menu\n\nDessert');
  });
});
