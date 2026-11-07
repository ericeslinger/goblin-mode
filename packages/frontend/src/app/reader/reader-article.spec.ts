import { Location } from '@angular/common';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { type ItemRecord, ItemsService } from './items.service';
import { ReaderArticle } from './reader-article';
import { ReaderService } from './reader.service';
import { Swipe } from './swipe';

@Component({ template: 'done' })
class DoneStub {}

const article = (id: string, title: string): ItemRecord => ({
  id,
  feedId: 'feed1',
  title,
  link: `https://x.test/${id}`,
  published: Date.parse('2026-11-07T12:00:00Z'),
  summary: '',
  content: `The text of ${title}.`,
  read: false,
  saved: false,
});

async function open(id: string) {
  const items = signal([article('a', 'First'), article('b', 'Last')]);
  const fake = {
    loaded: signal(true),
    inShelf: () => items(),
    find: (wanted: string) => items().find((i) => i.id === wanted),
    setRead: vi.fn((which: string, read: boolean) =>
      items.update((l) => l.map((i) => (i.id === which ? { ...i, read } : i))),
    ),
    setSaved: vi.fn(),
  };
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'reader/a/:id', component: ReaderArticle },
        { path: 'reader/done', component: DoneStub },
      ]),
      { provide: ItemsService, useValue: fake },
      {
        provide: ReaderService,
        useValue: { feeds: signal([{ id: 'feed1', title: 'Design notes' }]), images: signal(true) },
      },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/reader/a/${id}?in=f:Design`, ReaderArticle);
  const swipe = harness.fixture.debugElement.query(By.directive(Swipe));
  return {
    harness,
    el: harness.routeNativeElement as HTMLElement,
    swipe: swipe.injector.get(Swipe),
    main: swipe.nativeElement as HTMLElement,
  };
}

describe('ReaderArticle', () => {
  it('draws the panes from the top of the screen while dragged (Eric, 2026-11-07)', async () => {
    const { harness, el, swipe, main } = await open('a');
    // Read 500 px down.
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({ top: -500 } as DOMRect);
    swipe.dx.set(-30);
    await harness.fixture.whenStable();
    const pane = el.querySelector<HTMLElement>('.pane.next')!;
    expect(pane.querySelector('h1')?.textContent).toBe('Last');
    expect(pane.style.top).toBe('500px');
    // Measured when the drag starts, not as it moves.
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({ top: -20 } as DOMRect);
    swipe.dx.set(-60);
    await harness.fixture.whenStable();
    expect(el.querySelector<HTMLElement>('.pane.next')!.style.top).toBe('500px');
    swipe.dx.set(0);
    await harness.fixture.whenStable();
    expect(el.querySelector('.pane')).toBeNull();
    // The next drag measures afresh; at the top of the page the panes are at 0.
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({ top: 12 } as DOMRect);
    swipe.dx.set(-30);
    await harness.fixture.whenStable();
    expect(el.querySelector<HTMLElement>('.pane.next')!.style.top).toBe('0px');
  });

  it("goes on from the shelf's last article to the caught-up page (Eric, 2026-11-07)", async () => {
    const { harness, el, swipe } = await open('b');
    expect(swipe.canLeft()).toBe(true);
    expect(swipe.canRight()).toBe(true);
    // The next pane is the caught-up page, so the slide lands on what it showed.
    swipe.dx.set(-30);
    await harness.fixture.whenStable();
    const pane = el.querySelector('.pane.next')!;
    expect(pane.querySelector('h1')?.textContent).toBe('You are all caught up');
    expect(pane.textContent).toContain('Nothing more in Design.');
    expect(pane.querySelector('svg[role="img"]')).not.toBeNull();
    swipe.dx.set(0);
    await harness.fixture.whenStable();
    const next = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Next')!;
    expect(next.disabled).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Location).path()).toBe('/reader/done?in=f:Design');
    expect(harness.routeNativeElement?.textContent).toBe('done');
  });
});
