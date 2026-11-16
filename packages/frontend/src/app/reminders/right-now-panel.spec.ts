import { reminderDoc } from '../testing/fakes';
import { RightNowPanel } from './right-now-panel';
import { TestBed } from '@angular/core/testing';
import { ModulesService } from '../modules/modules.service';
import { PodcastsSeen } from '../podcasts/podcasts-seen';
import { ITEMS_API } from '../reader/items.service';
import { READER_API } from '../reader/reader.service';
import { READING_API } from '../reading/reading.service';
import type {
  FakeItemsApi,
  FakeModules,
  FakeReaderApi,
  FakeReadingApi,
  FakeSettingsApi,
} from '../testing/fakes';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { HOUR, NOW, buttonNamed, renderWithReminders } from '../testing/reminders';

describe('RightNowPanel', () => {
  it('says nothing is due when nothing is', async () => {
    const { el, push } = await renderWithReminders(RightNowPanel);
    await push([reminderDoc('s', { text: 'learn the banjo' })]);
    expect(el.textContent).toContain('Nothing to tend.');
    expect(el.querySelector('a[href="/right-now"]')?.textContent).toBe('Right Now');
  });

  it('shows at most three due items, soonest first, with the rest one tap away', async () => {
    const { el, push } = await renderWithReminders(RightNowPanel);
    await push([
      reminderDoc('a', { text: 'call the bank', dueAt: NOW - HOUR }),
      reminderDoc('b', { text: 'journal', dueAt: NOW + 3 * HOUR }),
      reminderDoc('c', { text: 'stretch', dueAt: NOW + HOUR }),
      reminderDoc('d', { text: 'water plants', dueAt: NOW + 5 * HOUR }),
      reminderDoc('e', { text: 'card for nephew', dueAt: NOW + 48 * HOUR }),
    ]);
    const items = [...el.querySelectorAll('li .text')].map((t) => t.textContent);
    expect(items).toEqual(['call the bank', 'stretch', 'journal']);
    expect(el.querySelector('a.more')?.textContent).toBe('1 more');
  });

  it('offers Undo after done', async () => {
    const { el, push, fixture, api } = await renderWithReminders(RightNowPanel);
    await push([reminderDoc('a', { text: 'call the bank', dueAt: NOW - HOUR })]);
    buttonNamed(el, 'Done: call the bank')!.click();
    await fixture.whenStable();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Done');
    buttonNamed(el, 'Undo')!.click();
    expect(api.set).toHaveBeenCalledTimes(2);
    expect(api.set.mock.lastCall![2]['status']).toBe('open');
  });

  it('mentions what has waited a week in the reading queue (#48)', async () => {
    const { el, fixture } = await renderWithReminders(RightNowPanel);
    expect(el.querySelector('.waited')).toBeNull();
    const api = TestBed.inject(READING_API) as unknown as FakeReadingApi;
    api.push([
      {
        id: 'p',
        data: {
          kind: 'pdf',
          name: 'Old paper',
          read: false,
          createdAt: { toMillis: () => NOW - 8 * 24 * HOUR },
        },
      },
      {
        id: 'q',
        data: { kind: 'link', name: 'New', read: false, createdAt: { toMillis: () => NOW } },
      },
    ]);
    await fixture.whenStable();
    const link = el.querySelector<HTMLAnchorElement>('.waited')!;
    expect(link.textContent).toContain('1 thing saved to read a week ago or more');
    expect(link.getAttribute('href')).toBe('/reading');
  });

  it('says what is new in one quiet line under the reminders (#288), each part to its module', async () => {
    localStorage.clear();
    const { el, fixture, push } = await renderWithReminders(RightNowPanel);
    await push([reminderDoc('a', { text: 'call the bank', dueAt: NOW - HOUR })]);
    const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
    const feeds = TestBed.inject(READER_API) as unknown as FakeReaderApi;
    const settings = TestBed.inject(SETTINGS_API) as unknown as FakeSettingsApi;
    const items = TestBed.inject(ITEMS_API) as unknown as FakeItemsApi;
    const item = (id: string, feedId: string, hoursAgo: number, more = {}) => ({
      id,
      data: {
        feedId,
        title: id,
        link: '',
        published: { toMillis: () => NOW - hoursAgo * HOUR },
        read: false,
        saved: false,
        ...more,
      },
    });
    const episode = (id: string, hoursAgo: number) =>
      item(id, 'p1', hoursAgo, {
        enclosure: { url: 'https://p.test/a.mp3', type: 'audio/mpeg' },
      });
    const line = () => el.querySelector<HTMLElement>('app-fresh-line p');
    const links = () =>
      [...el.querySelectorAll<HTMLAnchorElement>('app-fresh-line a')].map((a) => [
        a.textContent?.trim(),
        a.getAttribute('href'),
      ]);
    // Off: nothing.
    await fixture.whenStable();
    expect(line()).toBeNull();
    modules.set('reader', true);
    modules.set('podcasts', true);
    await fixture.whenStable();
    feeds.push([
      { id: 'a', data: { url: 'https://a.test/f', title: 'a', folders: ['Design'] } },
      { id: 'b', data: { url: 'https://b.test/f', title: 'b', folders: ['Games'] } },
      { id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [], kind: 'podcast' } },
    ]);
    settings.push({
      folderOrder: [],
      images: true,
      seenAt: { Games: NOW - 2 * HOUR },
      updatedAt: 1,
    });
    await fixture.whenStable();
    items.pushFeed('p1', [episode('e1', 1), episode('e2', 2)]);
    items.push('unread', [
      item('a1', 'a', 1),
      item('a2', 'a', 2),
      item('b1', 'b', 1),
      item('b2', 'b', 3),
      episode('e1', 1),
      episode('e2', 2),
    ]);
    await fixture.whenStable();
    // Design's two never seen, Games' one since it was opened; Podcasts' two.
    expect(line()?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'New since you last looked: Reader 3 · Podcasts 2',
    );
    expect(links()).toEqual([
      ['Reader 3', '/reader'],
      ['Podcasts 2', '/podcasts'],
    ]);
    // Under the reminders, and no line per folder here.
    const list = el.querySelector('ul[aria-labelledby="right-now-title"]')!;
    expect(list.compareDocumentPosition(line()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.querySelector('[aria-label="New in the Reader"]')).toBeNull();
    expect(el.textContent).not.toContain('new in Design');
    // A part with nothing new is left out; with nothing at all, no line.
    TestBed.inject(PodcastsSeen).markSeen();
    await fixture.whenStable();
    expect(links()).toEqual([['Reader 3', '/reader']]);
    modules.set('reader', false);
    await fixture.whenStable();
    expect(line()).toBeNull();
  });
});
