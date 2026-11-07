import { reminderDoc } from '../testing/fakes';
import { RightNowPanel } from './right-now-panel';
import { TestBed } from '@angular/core/testing';
import { ModulesService } from '../modules/modules.service';
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

  it('says what is new in the Reader (#173): three folders, then how many more', async () => {
    const { el, fixture } = await renderWithReminders(RightNowPanel);
    const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
    const feeds = TestBed.inject(READER_API) as unknown as FakeReaderApi;
    const settings = TestBed.inject(SETTINGS_API) as unknown as FakeSettingsApi;
    const items = TestBed.inject(ITEMS_API) as unknown as FakeItemsApi;
    const article = (id: string, feedId: string, hoursAgo: number) => ({
      id,
      data: {
        feedId,
        title: id,
        link: '',
        published: { toMillis: () => NOW - hoursAgo * HOUR },
        read: false,
        saved: false,
      },
    });
    const feed = (id: string, folder: string) => ({
      id,
      data: { url: `https://${id}.test/f`, title: id, folders: [folder] },
    });
    const lines = () =>
      [...el.querySelectorAll<HTMLAnchorElement>('[aria-label="New in the Reader"] a')].map((a) => [
        a.textContent?.trim(),
        a.getAttribute('href'),
      ]);
    // Off: nothing.
    await fixture.whenStable();
    expect(el.querySelector('app-reader-new')!.children).toHaveLength(0);
    modules.set('reader', true);
    await fixture.whenStable();
    feeds.push([
      feed('a', 'Design'),
      feed('b', 'Games'),
      feed('c', 'Apple'),
      feed('d', 'Music'),
      feed('e', 'Zines'),
    ]);
    settings.push({
      folderOrder: [],
      images: true,
      seenAt: { Games: NOW - 2 * HOUR },
      updatedAt: 1,
    });
    items.push('unread', [
      article('a1', 'a', 1),
      article('a2', 'a', 2),
      article('a3', 'a', 3),
      article('b1', 'b', 1),
      article('b2', 'b', 3),
      article('c1', 'c', 1),
      article('c2', 'c', 2),
      article('d1', 'd', 1),
      article('e1', 'e', 1),
    ]);
    await fixture.whenStable();
    expect(lines()).toEqual([
      ['3 new in Design', '/reader/f/Design'],
      ['2 new in Apple', '/reader/f/Apple'],
      ['1 new in Games', '/reader/f/Games'],
      ['and 2 more folders', '/reader'],
    ]);
    // All seen: nothing.
    settings.push({
      folderOrder: [],
      images: true,
      seenAt: Object.fromEntries(
        ['Design', 'Games', 'Apple', 'Music', 'Zines'].map((f) => [f, NOW]),
      ),
      updatedAt: 2,
    });
    await fixture.whenStable();
    expect(el.querySelector('app-reader-new ul')).toBeNull();
  });
});
