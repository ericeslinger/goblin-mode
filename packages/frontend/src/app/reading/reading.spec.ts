import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AttachmentsService } from '../attachments/attachments.service';
import { FakeAttachments } from '../testing/fakes';
import { Reading } from './reading';
import { type ReadingItem, ReadingService } from './reading.service';

async function render(items: ReadingItem[]) {
  const reading = {
    queue: signal(items),
    save: vi.fn((text: string) => (text.startsWith('https://') ? 'r9' : undefined)),
    setRead: vi.fn(),
  };
  await TestBed.configureTestingModule({
    imports: [Reading],
    providers: [
      provideRouter([]),
      { provide: ReadingService, useValue: reading },
      { provide: AttachmentsService, useValue: new FakeAttachments() },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Reading);
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, reading, fixture };
}

describe('Reading', () => {
  it('lists the queue, saves a link, and marks things read', async () => {
    const { el, reading, fixture } = await render([
      { id: 'a', kind: 'link', name: 'Seeds', url: 'https://x.test/s', read: false, savedAt: 1 },
      { id: 'b', kind: 'pdf', name: 'Paper', read: true, pages: 3, noteId: 'n1' },
      {
        id: 'c',
        kind: 'link',
        name: 'Gone',
        url: 'https://x.test/g',
        read: false,
        importError: 'the page answered 404',
      },
    ]);
    const rows = [...el.querySelectorAll('ul[aria-label="Reading queue"] li')];
    expect(rows.map((r) => r.querySelector('.name')!.textContent!.trim())).toEqual([
      'Seeds',
      'Paper',
      'Gone',
    ]);
    expect(rows[0].querySelector('a')!.getAttribute('href')).toBe('https://x.test/s');
    expect(rows[0].querySelector('a')!.getAttribute('rel')).toContain('noopener');
    expect(rows[1].querySelector('a')!.getAttribute('href')).toBe('/n/n1');
    expect(rows[1].textContent).toContain('PDF, 3 pages');
    expect(rows[2].textContent).toContain('Could not fetch: the page answered 404');

    el.querySelector<HTMLButtonElement>('[aria-label="Mark read: Seeds"]')!.click();
    expect(reading.setRead).toHaveBeenCalledWith('a', true);
    el.querySelector<HTMLButtonElement>('[aria-label="Mark unread: Paper"]')!.click();
    expect(reading.setRead).toHaveBeenCalledWith('b', false);

    const input = el.querySelector<HTMLInputElement>('input[type=url]')!;
    input.value = 'nonsense';
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(el.querySelector('[role=status]')!.textContent).toContain('not a link');
    input.value = 'https://example.com/paper';
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(reading.save).toHaveBeenLastCalledWith('https://example.com/paper');
    expect(input.value).toBe('');
    expect(el.querySelector('[role=status]')!.textContent).toContain('Saved');
  });

  it('opens a PDF in a tab made within the tap, and says why it cannot', async () => {
    const { el, fixture } = await render([{ id: 'p', kind: 'pdf', name: 'Paper', read: false }]);
    const fake = TestBed.inject(AttachmentsService) as unknown as FakeAttachments;
    const tab = { location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    fake.full.mockResolvedValue('blob:local/1');
    el.querySelector<HTMLButtonElement>('button.name')!.click();
    await vi.waitFor(() => expect(tab.location.href).toBe('blob:local/1'));
    // A blocked tab, with the file at hand.
    open.mockReturnValue(null);
    el.querySelector<HTMLButtonElement>('button.name')!.click();
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(el.querySelector('[role=status]')?.textContent).toContain('blocked the new tab'),
    );
    // No file to be had: the tab closes.
    open.mockReturnValue(tab as unknown as Window);
    fake.full.mockResolvedValue(undefined);
    el.querySelector<HTMLButtonElement>('button.name')!.click();
    await vi.waitFor(() => expect(tab.close).toHaveBeenCalled());
    open.mockRestore();
  });
});
