import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { NOW } from '../platform/platform';
import { FakeReader } from '../testing/fakes';
import { ReaderFeedHead } from './reader-feed-head';
import { type FeedRecord, ReaderService } from './reader.service';

const NOW_MS = Date.parse('2026-11-15T12:00:00Z');
const H = 3_600_000;

beforeAll(() => {
  // jsdom has no modal dialogs; the browser keeps focus inside and closes on Escape.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

@Component({ template: '' })
class Blank {}

async function open(feed: FeedRecord) {
  const reader = new FakeReader();
  reader.feeds.set([feed]);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'reader/s/:feedId', component: Blank },
        { path: 'reader/feeds', component: Blank },
      ]),
      { provide: ReaderService, useValue: reader },
      { provide: NOW, useValue: () => NOW_MS },
    ],
  });
  await RouterTestingHarness.create('/reader/s/' + feed.id);
  const fixture = TestBed.createComponent(ReaderFeedHead);
  fixture.componentRef.setInput('feedId', feed.id);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const text = (n: Element | null) => n?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const field = (name: string) =>
    text(
      [...el.querySelectorAll('dt')].find((dt) => text(dt) === name)?.nextElementSibling ?? null,
    );
  const button = (name: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? text(b)) === name,
    )!;
  return { reader, fixture, el, field, button, text };
}

describe('A feed’s page (2026-11-15)', () => {
  const failing: FeedRecord = {
    id: 'f1',
    url: 'https://livelaugh.blog/feed',
    title: 'Live laugh',
    site: 'https://livelaugh.blog/',
    folders: ['Friends', 'Daily'],
    dead: false,
    error: 'the site answered 404',
    errorCount: 3,
    fetchedAt: NOW_MS - 2 * H,
    nextFetchAt: NOW_MS + 8 * H,
  };

  it('shows its address, site, folders, module, state and looks', async () => {
    const { el, field } = await open(failing);
    expect(field('Address')).toContain('https://livelaugh.blog/feed');
    expect(el.querySelector('.address .url')!.textContent).toBe('https://livelaugh.blog/feed');
    const site = el.querySelector<HTMLAnchorElement>('dd a.url')!;
    expect(site.getAttribute('href')).toBe('https://livelaugh.blog/');
    expect(site.getAttribute('rel')).toBe('noopener noreferrer');
    expect(field('Folders')).toBe('Friends, Daily');
    expect(field('Filed in')).toBe('The Reader');
    expect(field('State')).toBe(
      'The address answers 404: nothing is there now. The feed may have moved.',
    );
    expect(field('Looks')).toBe(
      '3 looks in a row have failed, the last 2 h ago. Next look in 8 h. No article read from it yet.',
    );
  });

  it('offers Find the feed for a failing one, and switches, going to the new feed’s page', async () => {
    const { reader, fixture, el, button } = await open(failing);
    const fixes = [...el.querySelectorAll('.fixes button')].map((b) => b.textContent!.trim());
    expect(fixes).toEqual(['Find the feed']);
    button('Find the feed for Live laugh').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(reader.discover).toHaveBeenCalledWith('https://livelaugh.blog/');
    button('Switch Live laugh to New').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(reader.switchFeed).toHaveBeenCalledWith('f1', {
      url: 'https://site.test/new.xml',
      title: 'New',
    });
    expect(TestBed.inject(Router).url).toBe('/reader/s/moved-to');
    expect(el.querySelector('[role="status"]')!.textContent).toContain(
      'Switched Live laugh to https://site.test/new.xml.',
    );
  });

  it('says a feed asked to look again is waiting, not fine (review on #275)', async () => {
    const { field } = await open({
      id: 'f3',
      url: 'https://asked.test/rss',
      title: 'Asked',
      folders: [],
      dead: false,
      fetchedAt: NOW_MS - 30 * 60_000,
      nextFetchAt: NOW_MS - 1000,
    });
    expect(field('State')).toBe('Waiting for its next look.');
  });

  it('offers Look again for a feed that is fine, and copies its address', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { reader, fixture, field, button, el } = await open({
      id: 'f2',
      url: 'https://fine.test/rss',
      title: 'Fine',
      folders: [],
      dead: false,
      fetchedAt: NOW_MS - 30 * 60_000,
      lastItemAt: NOW_MS - 3 * 24 * H,
    });
    expect(field('State')).toBe('Fine: the last look read it.');
    expect(field('Folders')).toBe('Not in a folder');
    expect(field('Looks')).toContain('Newest article 3 days ago.');
    expect([...el.querySelectorAll('.fixes button')].map((b) => b.textContent!.trim())).toEqual([
      'Look again',
      'Find the feed',
    ]);
    button('Try Fine again').click();
    expect(reader.retry).toHaveBeenCalledWith('f2');
    button('Copy address').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledWith('https://fine.test/rss');
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Address copied.');
  });

  it('renames, refiles and removes from More, asking before removing', async () => {
    const { reader, fixture, el, button, text } = await open(failing);
    button('More for Live laugh').click();
    fixture.detectChanges();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect([...dialog.querySelectorAll('button')].map((b) => text(b))).toEqual([
      'Rename',
      'Folders',
      'Move to Podcasts For a feed that is mostly audio',
      'Remove',
      'Close',
    ]);
    button('Rename').click();
    fixture.detectChanges();
    const name = dialog.querySelector<HTMLInputElement>('input')!;
    expect(name.value).toBe('Live laugh');
    name.value = 'Live, laugh';
    dialog.querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(reader.setTitle).toHaveBeenCalledWith('f1', 'Live, laugh');
    expect(dialog.open).toBe(false);
    expect(el.querySelector('h3')!.textContent).toBe('About this feed');

    button('More for Live, laugh').click();
    fixture.detectChanges();
    button('Folders').click();
    fixture.detectChanges();
    const folders = dialog.querySelector<HTMLInputElement>('input')!;
    expect(folders.value).toBe('Friends, Daily');
    folders.value = 'Friends';
    dialog.querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(reader.setFolders).toHaveBeenCalledWith('f1', ['Friends']);

    button('More for Live, laugh').click();
    fixture.detectChanges();
    button('Remove').click();
    fixture.detectChanges();
    expect(reader.removeFeed).not.toHaveBeenCalled();
    expect(text(dialog)).toContain('Remove Live, laugh? Its articles go with it');
    button('Remove Live, laugh').click();
    await fixture.whenStable();
    expect(reader.removeFeed).toHaveBeenCalledWith('f1');
    expect(TestBed.inject(Router).url).toBe('/reader/feeds');
  });
});
