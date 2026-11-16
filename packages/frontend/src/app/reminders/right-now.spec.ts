import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { ModulesService } from '../modules/modules.service';
import { PodcastsSeen } from '../podcasts/podcasts-seen';
import { ITEMS_API } from '../reader/items.service';
import { READER_API } from '../reader/reader.service';
import {
  type FakeItemsApi,
  type FakeModules,
  type FakeReaderApi,
  type FakeSettingsApi,
  reminderDoc,
} from '../testing/fakes';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { RightNow } from './right-now';
import { HOUR, NOW, buttonNamed, renderWithReminders } from '../testing/reminders';

describe('RightNow', () => {
  it('lists every open reminder under its section, skipping empty ones', async () => {
    const { el, push } = await renderWithReminders(RightNow);
    await push([
      reminderDoc('a', { text: 'call the bank', dueAt: NOW - HOUR }),
      reminderDoc('b', { text: 'card for nephew', dueAt: NOW + 48 * HOUR }),
      reminderDoc('c', { text: 'learn the banjo' }),
    ]);
    const sections = [...el.querySelectorAll('section')].map((s) => [
      s.querySelector('h2')?.textContent,
      [...s.querySelectorAll('.text')].map((t) => t.textContent),
    ]);
    expect(sections).toEqual([
      ['Overdue', ['call the bank']],
      ['Soon', ['card for nephew']],
      ['Someday', ['learn the banjo']],
    ]);
  });

  it('tints the Overdue heading, keeping the word (#288)', async () => {
    const { el, push } = await renderWithReminders(RightNow);
    await push([
      reminderDoc('a', { text: 'call the bank', dueAt: NOW - HOUR }),
      reminderDoc('b', { text: 'learn the banjo' }),
    ]);
    const headings = [...el.querySelectorAll('h2')];
    expect(headings.map((h) => [h.textContent, h.classList.contains('overdue')])).toEqual([
      ['Overdue', true],
      ['Someday', false],
    ]);
  });

  it('puts what is new in the Reader and Podcasts under the reminders (#288)', async () => {
    localStorage.clear();
    const { el, fixture, push } = await renderWithReminders(RightNow);
    await push([reminderDoc('a', { text: 'call the bank', dueAt: NOW - HOUR })]);
    const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
    modules.set('reader', true);
    modules.set('podcasts', true);
    await fixture.whenStable();
    const section = el.querySelector('section')!;
    for (const line of ['app-reader-new', 'app-podcasts-new']) {
      const at = el.querySelector(line)!;
      expect(section.compareDocumentPosition(at) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('says so when there is nothing at all', async () => {
    const { el, push } = await renderWithReminders(RightNow);
    await push([]);
    expect(el.textContent).toContain('Nothing to tend. The garden is quiet.');
  });

  it('adds a reminder from +, which then closes the form', async () => {
    const { el, api, fixture } = await renderWithReminders(RightNow);
    buttonNamed(el, 'Add a reminder')!.click();
    await fixture.whenStable();
    const text = el.querySelector<HTMLInputElement>('input[name="text"]')!;
    text.value = 'buy stamps';
    text.dispatchEvent(new Event('input'));
    const repeat = el.querySelector<HTMLSelectElement>('select[name="repeat"]')!;
    repeat.value = 'weekly';
    repeat.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(el.textContent).toContain('Starts at 9:00 am.');
    buttonNamed(el, 'Add')!.click();
    await fixture.whenStable();
    expect(api.set.mock.lastCall![2]).toMatchObject({
      text: 'buy stamps',
      recurrence: { freq: 'weekly', time: '09:00' },
    });
    expect(el.querySelector('form')).toBeNull();
  });

  it('waits for sign-in before Add, and shows only sign-in when signed out', async () => {
    const { el, auth, fixture } = await renderWithReminders(RightNow);
    auth.user.set(undefined);
    buttonNamed(el, 'Add a reminder')!.click();
    await fixture.whenStable();
    const text = el.querySelector<HTMLInputElement>('input[name="text"]')!;
    text.value = 'buy stamps';
    text.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(buttonNamed(el, 'Add')!.disabled).toBe(true);
    auth.user.set({ uid: 'u1' } as User);
    await fixture.whenStable();
    expect(buttonNamed(el, 'Add')!.disabled).toBe(false);

    auth.user.set(null);
    await fixture.whenStable();
    expect(el.querySelector('app-sign-in')).toBeTruthy();
    expect(el.querySelector('app-add-reminder')).toBeNull();
  });

  it('closes the form on Cancel without adding', async () => {
    const { el, api, fixture } = await renderWithReminders(RightNow);
    buttonNamed(el, 'Add a reminder')!.click();
    await fixture.whenStable();
    buttonNamed(el, 'Cancel')!.click();
    await fixture.whenStable();
    expect(el.querySelector('form')).toBeNull();
    expect(api.set).not.toHaveBeenCalled();
  });
  it('says what is new in the Reader (#173) under the reminders: three folders, then how many more', async () => {
    const { el, fixture } = await renderWithReminders(RightNow);
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
      ['and 2 more folders', '/reader/folders'],
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

  it('says what is new in Podcasts since Latest was seen (#251), and the Reader’s line leaves it out', async () => {
    localStorage.clear();
    const { el, fixture } = await renderWithReminders(RightNow);
    const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
    const feeds = TestBed.inject(READER_API) as unknown as FakeReaderApi;
    const items = TestBed.inject(ITEMS_API) as unknown as FakeItemsApi;
    const episode = (id: string, hoursAgo: number, more: Record<string, unknown> = {}) => ({
      id,
      data: {
        feedId: 'p1',
        title: id,
        link: '',
        published: { toMillis: () => NOW - hoursAgo * HOUR },
        read: false,
        saved: false,
        enclosure: { url: 'https://p.test/a.mp3', type: 'audio/mpeg' },
        ...more,
      },
    });
    const line = () => el.querySelector<HTMLAnchorElement>('app-podcasts-new a');
    modules.set('podcasts', true);
    modules.set('reader', true);
    await fixture.whenStable();
    feeds.push([
      { id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [], kind: 'podcast' } },
    ]);
    await fixture.whenStable();
    items.pushFeed('p1', [
      episode('e1', 1),
      episode('e2', 2, { read: true }),
      episode('e3', 3, { position: 90 }),
      episode('e4', 4, { played: true }),
    ]);
    items.push('unread', [episode('e1', 1), episode('e2', 2)]);
    await fixture.whenStable();
    // New is not heard and no place kept: notes read is still new.
    expect(line()?.textContent?.trim()).toBe('2 new in Podcasts');
    expect(line()?.getAttribute('href')).toBe('/podcasts');
    expect(el.querySelector('[aria-label="New in the Reader"]')).toBeNull();
    // Latest seen: nothing, until a newer episode comes out.
    TestBed.inject(PodcastsSeen).markSeen();
    await fixture.whenStable();
    expect(line()).toBeNull();
    items.pushFeed('p1', [episode('e5', -1), episode('e1', 1)]);
    await fixture.whenStable();
    expect(line()?.textContent?.trim()).toBe('1 new in Podcasts');
    // The module off: nothing.
    modules.set('podcasts', false);
    await fixture.whenStable();
    expect(line()).toBeNull();
  });
});
