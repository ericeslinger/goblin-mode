import { Location } from '@angular/common';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ReaderDone } from './reader-done';
import { ReaderService } from './reader.service';

@Component({ template: 'the list' })
class ListStub {}

async function open(url: string) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'reader/done', component: ReaderDone },
        { path: 'reader/f/:folder', component: ListStub },
      ]),
      {
        provide: ReaderService,
        useValue: { feeds: signal([{ id: 'feed1', title: 'Design notes', folders: [] }]) },
      },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url, ReaderDone);
  return { harness, el: harness.routeNativeElement as HTMLElement };
}

describe('ReaderDone (Eric, 2026-11-07)', () => {
  it('says the shelf is done, links back to its list, and draws the goblin', async () => {
    const { el } = await open('/reader/done?in=f:Design');
    expect(el.querySelector('h1')?.textContent).toBe('You are all caught up');
    expect(el.textContent).toContain('Nothing more in Design.');
    const back = [...el.querySelectorAll('a')].find((a) => a.textContent === 'Back')!;
    expect(back.getAttribute('href')).toBe('/reader/f/Design');
    const art = el.querySelector('svg[role="img"]')!;
    expect(art.getAttribute('aria-label')).toBe(
      'A goblin opens an empty box, and a fly buzzes out of it',
    );
  });

  it("names a feed's shelf by the feed and links back to it", async () => {
    const { el } = await open('/reader/done?in=s:feed1');
    expect(el.textContent).toContain('Nothing more in Design notes.');
    const back = [...el.querySelectorAll('a')].find((a) => a.textContent === 'Back')!;
    expect(back.getAttribute('href')).toBe('/reader/s/feed1');
  });

  it('goes back to the last article on k, and to the list when opened directly', async () => {
    const { harness } = await open('/reader/done?in=f:all');
    const location = TestBed.inject(Location);
    const back = vi.spyOn(location, 'back');
    // Opened first, with nothing before it in the app: the list.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    await harness.fixture.whenStable();
    expect(back).not.toHaveBeenCalled();
    expect(location.path()).toBe('/reader/f/all');
    await harness.navigateByUrl('/reader/done?in=f:all', ReaderDone);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    expect(back).toHaveBeenCalled();
  });
});
