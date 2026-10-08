import { reminderDoc } from '../testing/fakes';
import { RightNowPanel } from './right-now-panel';
import { TestBed } from '@angular/core/testing';
import { READING_API } from '../reading/reading.service';
import type { FakeReadingApi } from '../testing/fakes';
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
});
