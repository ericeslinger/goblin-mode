import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { NotesService } from '../notes/notes.service';
import { FakeNotes } from '../testing/fakes';
import {
  ATTACHMENTS_API,
  AttachmentsService,
  OBJECT_URLS,
  captionFor,
  safeName,
} from './attachments.service';
import { type QueuedUpload, UPLOAD_QUEUE, type UploadQueue } from './upload-queue';

class MemoryQueue implements UploadQueue {
  readonly items = new Map<string, QueuedUpload>();
  all = async () => [...this.items.values()];
  put = async (item: QueuedUpload) => void this.items.set(item.id, { ...item });
  remove = async (id: string) => void this.items.delete(id);
}

function setup(queued: QueuedUpload[] = []) {
  const user = signal<User | null | undefined>(undefined);
  const queue = new MemoryQueue();
  for (const item of queued) queue.items.set(item.id, item);
  const api = {
    record: vi.fn(),
    files: vi.fn(async (_path: string): Promise<{ path?: string; thumbPath?: string }> => ({})),
    upload: vi.fn(async () => undefined),
    download: vi.fn(async () => new Blob(['x'])),
    serverTime: () => 'now',
  };
  let made = 0;
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { user } },
      { provide: NotesService, useValue: new FakeNotes() },
      { provide: UPLOAD_QUEUE, useValue: queue },
      { provide: ATTACHMENTS_API, useValue: api },
      { provide: OBJECT_URLS, useValue: { create: () => `blob:local/${++made}` } },
    ],
  });
  const service = TestBed.inject(AttachmentsService);
  const signIn = async () => {
    user.set({ uid: 'u1' } as User);
    TestBed.tick();
    await service.drain();
    await flush();
  };
  return { service, queue, api, signIn };
}

/** Lets pending promise chains settle, with real or fake timers. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const photo = (name = 'Dinner menu.jpg', type = 'image/jpeg', size = 3) =>
  new File(['x'.repeat(size)], name, { type });

describe('AttachmentsService', () => {
  it('keeps a photo taken before sign-in on the device, then records and uploads it', async () => {
    const { service, queue, api, signIn } = setup();
    const id = service.newId();
    expect(id).toBe('new1');
    await service.attach(photo(), id, 'image/jpeg', 'n1');
    // On the device at once, shown from there, and waiting.
    expect(queue.items.get('new1')).toMatchObject({ name: 'Dinner-menu.jpg', noteId: 'n1' });
    expect(service.resolve('new1')).toBe('blob:local/1');
    expect([...service.waiting()]).toEqual(['new1']);
    expect(api.record).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();

    await signIn();
    const path = 'users/u1/attachments/new1/Dinner-menu.jpg';
    expect(api.record).toHaveBeenCalledWith(
      'users/u1/attachments/new1',
      expect.objectContaining({ kind: 'image', path, noteId: 'n1', toRead: false, read: false }),
    );
    expect(api.upload).toHaveBeenCalledWith(path, expect.any(File), 'image/jpeg');
    expect(queue.items.size).toBe(0);
    expect(service.waiting().size).toBe(0);
    // Still shown from the device's copy.
    expect(service.resolve('new1')).toBe('blob:local/1');
  });

  it('keeps a photo whose upload failed, and tries again when back online', async () => {
    const { service, queue, api, signIn } = setup();
    api.upload.mockRejectedValueOnce(new Error('offline'));
    await signIn();
    await service.attach(photo(), 'p1', 'image/jpeg');
    await service.drain();
    expect(queue.items.size).toBe(1);
    window.dispatchEvent(new Event('online'));
    await service.drain();
    expect(queue.items.size).toBe(0);
    expect(api.upload).toHaveBeenCalledTimes(2);
    // Recorded once, while signed in.
    expect(api.record).toHaveBeenCalledOnce();
  });

  it('knows a photo by its bytes, not its name, and turns away the rest', async () => {
    const { service } = setup();
    const bytes = (b: number[] | string, name: string, type: string) =>
      new File([typeof b === 'string' ? b : Uint8Array.from(b)], name, { type });
    // A WebP saved as .jpg: the browser says JPEG.
    expect(
      await service.inspect(
        bytes('RIFF\u0001\u0002\u0003\u0004WEBPVP8 ', 'menu.jpg', 'image/jpeg'),
      ),
    ).toEqual({ type: 'image/webp' });
    expect(
      await service.inspect(bytes([0xff, 0xd8, 0xff, 0xe0, 0], 'a.jpg', 'image/jpeg')),
    ).toEqual({ type: 'image/jpeg' });
    expect(await service.inspect(bytes('<html><script>', 'x.jpg', 'image/jpeg'))).toHaveProperty(
      'error',
    );
    expect(await service.inspect(bytes('%PDF-1.7', 'doc.pdf', 'application/pdf'))).toHaveProperty(
      'error',
    );
    const big = bytes([0xff, 0xd8, 0xff], 'big.jpg', 'image/jpeg');
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    expect(await service.inspect(big)).toEqual({ error: 'That photo is over 25 MB.' });
  });

  it('keeps a photo as the type its bytes are', async () => {
    const { service, queue } = setup();
    await service.attach(photo('menu.jpg', 'image/jpeg'), 't1', 'image/webp');
    expect(queue.items.get('t1')?.contentType).toBe('image/webp');
  });

  it('keeps a photo in memory when the device store fails', async () => {
    const { service, queue, api, signIn } = setup();
    queue.put = async () => {
      throw new Error('quota');
    };
    await signIn();
    await service.attach(photo(), 'm1', 'image/jpeg');
    expect(service.waiting().has('m1')).toBe(true);
    expect(service.inMemory()).toBe(true);
    await service.drain();
    expect(api.upload).toHaveBeenCalledWith(
      'users/u1/attachments/m1/Dinner-menu.jpg',
      expect.any(File),
      'image/jpeg',
    );
    expect(service.waiting().size).toBe(0);
  });

  it('retries failed uploads with a back-off, and says when they keep failing', async () => {
    vi.useFakeTimers();
    try {
      const { service, api, signIn } = setup();
      api.upload.mockRejectedValue(new Error('denied'));
      await signIn();
      await service.attach(photo(), 'f1', 'image/jpeg');
      await service.drain();
      expect(service.struggling()).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(service.struggling()).toBe(true);
      api.upload.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(service.waiting().size).toBe(0);
      expect(service.struggling()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows photos still queued from an earlier visit', async () => {
    const { service, signIn } = setup([
      {
        id: 'old',
        name: 'a.png',
        contentType: 'image/png',
        size: 1,
        blob: new Blob(['x']),
        recorded: true,
      },
    ]);
    await signIn();
    expect(service.resolve('old')).toBe('blob:local/1');
  });

  it('downloads a photo from another device once, and says when it arrives', async () => {
    const { service, api, signIn } = setup();
    await signIn();
    api.files.mockResolvedValue({ path: 'users/u1/attachments/a9/x.jpg' });
    const before = service.arrived();
    expect(service.resolve('a9')).toBeUndefined();
    await flush();
    expect(api.download).toHaveBeenCalledWith('users/u1/attachments/a9/x.jpg');
    expect(service.arrived()).toBe(before + 1);
    expect(service.resolve('a9')).toMatch(/^blob:local\//);
    expect(api.download).toHaveBeenCalledOnce();
    // No thumbnail: the same download is the full photo.
    expect(await service.full('a9')).toBe(service.resolve('a9'));
    expect(api.download).toHaveBeenCalledOnce();
  });

  it('draws the thumbnail inline, and fetches the full photo for the viewer', async () => {
    const { service, api, signIn } = setup();
    await signIn();
    api.files.mockResolvedValue({
      path: 'users/u1/attachments/a8/x.jpg',
      thumbPath: 'users/u1/attachments/a8/thumb_x.webp',
    });
    service.resolve('a8');
    await flush();
    expect(api.download).toHaveBeenLastCalledWith('users/u1/attachments/a8/thumb_x.webp');
    const inline = service.resolve('a8');
    const full = await service.full('a8');
    expect(api.download).toHaveBeenLastCalledWith('users/u1/attachments/a8/x.jpg');
    expect(full).not.toBe(inline);
    // Once.
    expect(await service.full('a8')).toBe(full);
    expect(api.download).toHaveBeenCalledTimes(2);
  });

  it('shows the device its own full copy, both inline and whole', async () => {
    const { service, api } = setup();
    await service.attach(photo(), 'd1', 'image/jpeg');
    expect(await service.full('d1')).toBe(service.resolve('d1'));
    expect(api.download).not.toHaveBeenCalled();
  });
});

describe('names', () => {
  it('makes file names Storage and the rules take', () => {
    expect(safeName('IMG 2041 (1).HEIC')).toBe('IMG-2041-1-.HEIC');
    expect(safeName('../../etc')).toBe('etc');
    expect(safeName('😀')).toBe('image');
    // The server's thumbnail prefix is its own.
    expect(safeName('thumb_x.jpg')).toBe('x.jpg');
  });

  it('captions a photo by its name', () => {
    expect(captionFor('Dinner menu.jpg')).toBe('Dinner menu');
    expect(captionFor('.jpg')).toBe('image');
  });
});
