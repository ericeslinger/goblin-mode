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
    filePath: vi.fn(async (_path: string): Promise<string | undefined> => undefined),
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
    await new Promise((done) => setTimeout(done));
  };
  return { service, queue, api, signIn };
}

const photo = (name = 'Dinner menu.jpg', type = 'image/jpeg', size = 3) =>
  new File(['x'.repeat(size)], name, { type });

describe('AttachmentsService', () => {
  it('keeps a photo taken before sign-in on the device, then records and uploads it', async () => {
    const { service, queue, api, signIn } = setup();
    const result = await service.attach(photo(), 'n1');
    expect(result).toEqual({ id: 'new1', caption: 'Dinner menu' });
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
    await service.attach(photo());
    await service.drain();
    expect(queue.items.size).toBe(1);
    window.dispatchEvent(new Event('online'));
    await service.drain();
    expect(queue.items.size).toBe(0);
    expect(api.upload).toHaveBeenCalledTimes(2);
    // Recorded once, while signed in.
    expect(api.record).toHaveBeenCalledOnce();
  });

  it('turns away files that are not photos, or too big', async () => {
    const { service, queue } = setup();
    expect(await service.attach(photo('page.svg', 'image/svg+xml'))).toHaveProperty('error');
    expect(await service.attach(photo('doc.pdf', 'application/pdf'))).toHaveProperty('error');
    const big = photo();
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    expect(await service.attach(big)).toHaveProperty('error');
    expect(queue.items.size).toBe(0);
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
    api.filePath.mockResolvedValue('users/u1/attachments/a9/x.jpg');
    const before = service.arrived();
    expect(service.resolve('a9')).toBeUndefined();
    await new Promise((done) => setTimeout(done));
    expect(api.download).toHaveBeenCalledWith('users/u1/attachments/a9/x.jpg');
    expect(service.arrived()).toBe(before + 1);
    expect(service.resolve('a9')).toMatch(/^blob:local\//);
    expect(api.download).toHaveBeenCalledOnce();
  });
});

describe('names', () => {
  it('makes file names Storage and the rules take', () => {
    expect(safeName('IMG 2041 (1).HEIC')).toBe('IMG-2041-1-.HEIC');
    expect(safeName('../../etc')).toBe('etc');
    expect(safeName('😀')).toBe('image');
  });

  it('captions a photo by its name', () => {
    expect(captionFor('Dinner menu.jpg')).toBe('Dinner menu');
    expect(captionFor('.jpg')).toBe('image');
  });
});
