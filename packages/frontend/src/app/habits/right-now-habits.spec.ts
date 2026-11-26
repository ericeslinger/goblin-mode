import { TestBed } from '@angular/core/testing';
import { ModulesService } from '../modules/modules.service';
import { RightNow } from '../reminders/right-now';
import { type FakeHabitsApi, type FakeModules, habitDoc, reminderDoc } from '../testing/fakes';
import { HOUR, NOW, buttonNamed, renderWithReminders } from '../testing/reminders';
import { HABITS_API, HabitsService } from './habits.service';
import { newDataKey, openHabitAnswer } from '@mossgoblin/schema';
import { NoteKeyService } from '../notes/note-key.service';
import type { FakeNoteKeys } from '../testing/fakes';

const DAY = 24 * HOUR;

async function render({ on = true } = {}) {
  const r = await renderWithReminders(RightNow);
  const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
  if (on) modules.set('habits', true);
  await r.fixture.whenStable();
  const api = TestBed.inject(HABITS_API) as FakeHabitsApi;
  return {
    ...r,
    modules,
    api,
    habitsService: TestBed.inject(HabitsService),
    async habits(
      docs: ReturnType<typeof habitDoc>[],
      logs: Record<string, Record<string, { state: 'done' | 'skipped' }>> = {},
    ) {
      api.pushHabits(docs);
      await r.fixture.whenStable();
      for (const id of api.logs.keys()) api.pushLog(id, logs[id]);
      await r.fixture.whenStable();
    },
  };
}

const section = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('section[aria-labelledby="section-habits"]');
const rows = (el: HTMLElement) =>
  [...(section(el)?.querySelectorAll('li') ?? [])].map(
    (li) => li.querySelector('.text')?.textContent,
  );

describe('Right Now’s Habits (#324)', () => {
  it('lists today’s habits after what is overdue or today, before what comes later', async () => {
    const r = await render();
    await r.push([
      reminderDoc('late', { text: 'call the bank', dueAt: NOW - HOUR }),
      reminderDoc('later', { text: 'learn the banjo' }),
    ]);
    await r.habits([habitDoc('floss', { name: 'Floss' })]);
    const headings = [...r.el.querySelectorAll('h2')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['Overdue', 'Habits', 'Someday']);
    expect(rows(r.el)).toEqual(['Floss']);
  });

  it('shows nothing of Habits while the module is off', async () => {
    const r = await render({ on: false });
    await r.push([]);
    expect(section(r.el)).toBeNull();
    expect(r.api.listenHabits).not.toHaveBeenCalled();
    expect(r.el.textContent).toContain('Nothing to tend.');
  });

  it('ticks a habit done: it leaves the list for the settled line, with Undo', async () => {
    const r = await render();
    await r.push([]);
    await r.habits([habitDoc('floss', { name: 'Floss' }), habitDoc('run', { name: 'Run' })]);
    expect(r.el.textContent).not.toContain('Nothing to tend.');
    buttonNamed(r.el, 'Done: Floss')!.click();
    await r.fixture.whenStable();
    expect(r.api.set.mock.lastCall![1]).toBe('users/u1/habitLogs/floss_2026-10');
    // The cache hands the write back at once.
    r.api.pushLog('floss_2026-10', { '06': { state: 'done' } });
    await r.fixture.whenStable();
    expect(rows(r.el)).toEqual(['Run']);
    expect(section(r.el)!.querySelector('.settled')?.textContent).toBe('Done today: Floss');
    const status = section(r.el)!.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Floss: done');
    buttonNamed(r.el, 'Skip: Run')!.click();
    await r.fixture.whenStable();
    expect(status.textContent).toContain('Run: skipped');
    buttonNamed(r.el, 'Undo')!.click();
    await r.fixture.whenStable();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ days: { '06': 'DELETE' } });
  });

  it('offers yesterday quietly, on a habit that could have been logged then', async () => {
    const r = await render();
    await r.push([]);
    await r.habits(
      [
        habitDoc('floss', { name: 'Floss', createdAt: NOW - 3 * DAY }),
        habitDoc('new', { name: 'Read', createdAt: NOW - HOUR }),
        habitDoc('run', { name: 'Run', createdAt: NOW - 3 * DAY }),
      ],
      { 'run_2026-10': { '05': { state: 'done' } } },
    );
    const yesterday = [...r.el.querySelectorAll('button')]
      .filter((b) => b.textContent?.trim() === 'Yesterday?')
      .map((b) => b.getAttribute('aria-label'));
    expect(yesterday).toEqual(['Yesterday? Mark Floss done yesterday']);
    buttonNamed(r.el, 'Yesterday? Mark Floss done yesterday')!.click();
    await r.fixture.whenStable();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ days: { '05': { state: 'done' } } });
    expect(section(r.el)!.querySelector('[role="status"]')?.textContent).toContain(
      'Floss: done yesterday',
    );
  });

  it('puts the focus on Undo after a tick, and on the heading after Undo (review of #328)', async () => {
    const r = await render();
    await r.push([]);
    await r.habits([habitDoc('floss', { name: 'Floss' }), habitDoc('run', { name: 'Run' })]);
    buttonNamed(r.el, 'Done: Floss')!.focus();
    buttonNamed(r.el, 'Done: Floss')!.click();
    await r.fixture.whenStable();
    r.api.pushLog('floss_2026-10', { '06': { state: 'done' } });
    await r.fixture.whenStable();
    expect(buttonNamed(r.el, 'Done: Floss')).toBeUndefined();
    expect(document.activeElement).toBe(buttonNamed(r.el, 'Undo'));
    buttonNamed(r.el, 'Undo')!.click();
    await r.fixture.whenStable();
    const heading = section(r.el)!.querySelector('h2 a');
    expect(document.activeElement).toBe(heading);

    // Undo lapsing with the focus on it leaves it on the heading too.
    buttonNamed(r.el, 'Skip: Run')!.click();
    await r.fixture.whenStable();
    expect(document.activeElement).toBe(buttonNamed(r.el, 'Undo'));
    r.habitsService.undoable.set(null);
    await r.fixture.whenStable();
    expect(buttonNamed(r.el, 'Undo')).toBeUndefined();
    expect(document.activeElement).toBe(heading);
  });

  it('leaves an archived habit off', async () => {
    const r = await render();
    await r.push([]);
    await r.habits([habitDoc('floss', { name: 'Floss', archived: true })]);
    expect(section(r.el)).toBeNull();
  });

  it('says a tick the server refused, with Try again and Dismiss (review of #327)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await render();
    await r.push([]);
    await r.habits([habitDoc('floss', { name: 'Floss' })]);
    const alert = () => section(r.el)!.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert().textContent?.trim()).toBe('');
    r.api.set.mockReturnValueOnce(
      Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' })),
    );
    buttonNamed(r.el, 'Done: Floss')!.click();
    await r.fixture.whenStable();
    // Refused, the tick is gone, and its Undo with it.
    expect(alert().textContent).toContain('Floss could not be saved for today.');
    expect(section(r.el)!.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
    expect(rows(r.el)).toEqual(['Floss']);
    const sent = r.api.set.mock.lastCall;
    buttonNamed(r.el, 'Try again: Floss')!.click();
    await r.fixture.whenStable();
    expect(r.api.set).toHaveBeenCalledTimes(2);
    expect(r.api.set.mock.lastCall).toEqual(sent);
    expect(alert().textContent?.trim()).toBe('');

    r.api.set.mockReturnValueOnce(Promise.reject(new Error('denied')));
    buttonNamed(r.el, 'Skip: Floss')!.click();
    await r.fixture.whenStable();
    expect(alert().textContent).toContain('Floss could not be saved for today.');
    buttonNamed(r.el, 'Dismiss: Floss')!.click();
    await r.fixture.whenStable();
    expect(alert().textContent?.trim()).toBe('');
    expect(r.api.set).toHaveBeenCalledTimes(3);
  });

  it('lists a habit of twice a week each day until met, with its count (2026-11-23)', async () => {
    const r = await render();
    const made = { createdAt: NOW - 30 * DAY };
    // Tuesday 6 October; Monday the 5th not logged.
    await r.habits([habitDoc('pots', { name: 'Pottery', schedule: 'weekly', times: 2, ...made })]);
    expect(rows(r.el)).toEqual(['Pottery']);
    const when = () => section(r.el)!.querySelector('li .when')?.textContent;
    expect(when()).toBe('0 of 2 this week');
    // Yesterday counts as a day of its own, so it is offered.
    expect(buttonNamed(r.el, 'Yesterday? Mark Pottery done yesterday')).toBeDefined();
    buttonNamed(r.el, 'Done: Pottery')!.click();
    r.api.pushLog('pots_2026-10', { '06': { state: 'done' } });
    await r.fixture.whenStable();
    // Done today: not offered again today, its week still open.
    expect(rows(r.el)).toEqual([]);
    expect(section(r.el)!.querySelector('.settled')?.textContent).toBe('Done today: Pottery');
    // Logged yesterday too: 2 of 2, still settled today.
    r.api.pushLog('pots_2026-10', { '05': { state: 'done' }, '06': { state: 'done' } });
    await r.fixture.whenStable();
    expect(section(r.el)!.querySelector('.settled')?.textContent).toBe('Done today: Pottery');
  });

  it('offers it again the next day while its week is unmet (2026-11-23)', async () => {
    const r = await render();
    const made = { createdAt: NOW - 30 * DAY };
    await r.habits([habitDoc('pots', { name: 'Pottery', schedule: 'weekly', times: 2, ...made })], {
      'pots_2026-10': { '05': { state: 'done' } },
    });
    expect(rows(r.el)).toEqual(['Pottery']);
    expect(section(r.el)!.querySelector('li .when')?.textContent).toBe('1 of 2 this week');
    // Yesterday is logged already: no Yesterday?.
    expect(section(r.el)!.querySelector('[aria-label^="Yesterday?"]')).toBeNull();
  });

  it('lists a habit on its own weekday only, named so (2026-11-25)', async () => {
    const r = await render();
    const made = { schedule: 'weekly', createdAt: NOW - 30 * DAY };
    // Tuesday 6 October.
    await r.habits([
      habitDoc('bins', { ...made, name: 'Bins', weekday: 'Tue', time: '19:00' }),
      habitDoc('glass', { ...made, name: 'Glass', weekday: 'Wed' }),
      habitDoc('rec', { ...made, name: 'Recycling', weekday: 'Mon' }),
    ]);
    expect(rows(r.el)).toEqual(['Bins']);
    expect(section(r.el)!.querySelector('li .when')?.textContent).toBe('Every Tuesday · 19:00');
    expect(section(r.el)!.querySelector('[aria-label^="Yesterday?"]')).toBeNull();
    buttonNamed(r.el, 'Done: Bins')!.click();
    r.api.pushLog('bins_2026-10', { '06': { state: 'done' } });
    await r.fixture.whenStable();
    expect(rows(r.el)).toEqual([]);
    expect(section(r.el)!.querySelector('.settled')?.textContent).toBe('Done today: Bins');
  });

  it('shows a weekly or monthly habit each day of its period until settled (step 5)', async () => {
    const r = await render();
    const made = { createdAt: NOW - 30 * DAY };
    await r.habits(
      [
        habitDoc('pots', { name: 'Pots', schedule: 'weekly', ...made }),
        habitDoc('rent', { name: 'Rent', schedule: 'monthly', ...made }),
        habitDoc('bins', { name: 'Bins', schedule: 'weekly', ...made }),
      ],
      // Bins was put out Monday: settled, so gone for the rest of the week.
      { 'bins_2026-10': { '05': { state: 'done' } } },
    );
    expect(rows(r.el)).toEqual(['Pots', 'Rent']);
    const when = [...section(r.el)!.querySelectorAll('li .when')].map((w) => w.textContent);
    expect(when).toEqual(['This week', 'This month']);
    // Tuesday is not the first day of the week nor of the month: no Yesterday?.
    expect(section(r.el)!.querySelector('[aria-label^="Yesterday?"]')).toBeNull();
    expect(section(r.el)!.textContent).not.toContain('Bins');

    buttonNamed(r.el, 'Done: Pots')!.click();
    r.api.pushLog('pots_2026-10', { '06': { state: 'done' } });
    buttonNamed(r.el, 'Skip: Rent')!.click();
    r.api.pushLog('rent_2026-10', { '06': { state: 'skipped' } });
    await r.fixture.whenStable();
    expect(rows(r.el)).toEqual([]);
    expect(section(r.el)!.querySelector('.settled')?.textContent).toBe(
      'Done today: Pots · Skipped today: Rent',
    );
  });
  describe('answers (step 6, 2026-11-22)', () => {
    afterEach(() => localStorage.clear());

    it('asks a choice habit in place on its tick, one tap answering it done', async () => {
      const r = await render();
      const key = newDataKey();
      (TestBed.inject(NoteKeyService) as unknown as FakeNoteKeys).key.set(key);
      await r.push([]);
      await r.habits([
        habitDoc('mood', { name: 'Mood', answer: 'choice', choices: ['calm', 'low', 'cross'] }),
      ]);
      buttonNamed(r.el, 'Done: Mood')!.click();
      await r.fixture.whenStable();
      expect(r.api.set).not.toHaveBeenCalled();
      const group = section(r.el)!.querySelector<HTMLElement>(
        '[aria-label="Mood today: choose one"]',
      )!;
      expect(document.activeElement?.textContent?.trim()).toBe('calm');
      buttonNamed(group, 'low')!.click();
      await r.fixture.whenStable();
      const [, path, data] = r.api.set.mock.lastCall!;
      expect(path).toBe('users/u1/habitLogs/mood_2026-10');
      const answer = (data as { days: Record<string, { answer: string }> }).days['06'].answer;
      expect(answer).not.toContain('low');
      expect(openHabitAnswer(key, 'u1', 'mood', '2026-10-06', answer)).toBe('low');
      expect(section(r.el)!.querySelector('[role="status"]')?.textContent).toContain('Mood: low');
    });

    it('takes a text habit’s line, and Escape puts it away logging nothing', async () => {
      const r = await render();
      (TestBed.inject(NoteKeyService) as unknown as FakeNoteKeys).key.set(newDataKey());
      await r.push([]);
      await r.habits([habitDoc('walk', { name: 'Walk', answer: 'text' })]);
      buttonNamed(r.el, 'Done: Walk')!.click();
      await r.fixture.whenStable();
      const input = section(r.el)!.querySelector<HTMLInputElement>('input[type="text"]')!;
      expect(document.activeElement).toBe(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await r.fixture.whenStable();
      expect(section(r.el)!.querySelector('input[type="text"]')).toBeNull();
      expect(r.api.set).not.toHaveBeenCalled();
      buttonNamed(r.el, 'Done: Walk')!.click();
      await r.fixture.whenStable();
      const again = section(r.el)!.querySelector<HTMLInputElement>('input[type="text"]')!;
      again.value = 'to the river';
      again.dispatchEvent(new Event('input'));
      buttonNamed(section(r.el)!, 'Done')!.click();
      await r.fixture.whenStable();
      expect(r.api.set.mock.lastCall![2]).toMatchObject({ days: { '06': { state: 'done' } } });
      expect(JSON.stringify(r.api.set.mock.lastCall![2])).not.toContain('river');
    });

    it('gives the focus back to Yesterday? when its ask is put away (review of #332)', async () => {
      const r = await render();
      (TestBed.inject(NoteKeyService) as unknown as FakeNoteKeys).key.set(newDataKey());
      await r.push([]);
      await r.habits([
        habitDoc('walk', { name: 'Walk', answer: 'text', createdAt: NOW - 2 * DAY }),
      ]);
      const yesterday = buttonNamed(r.el, 'Yesterday? Mark Walk done yesterday')!;
      yesterday.click();
      await r.fixture.whenStable();
      const input = section(r.el)!.querySelector<HTMLInputElement>('input[type="text"]')!;
      expect(document.activeElement).toBe(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await r.fixture.whenStable();
      expect(document.activeElement).toBe(buttonNamed(r.el, 'Yesterday? Mark Walk done yesterday'));
      // Today's tick still gets it back from today's ask.
      buttonNamed(r.el, 'Done: Walk')!.click();
      await r.fixture.whenStable();
      section(r.el)!
        .querySelector<HTMLInputElement>('input[type="text"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await r.fixture.whenStable();
      expect(document.activeElement).toBe(buttonNamed(r.el, 'Done: Walk'));
      expect(r.api.set).not.toHaveBeenCalled();
    });

    it('opens a note habit’s entry on its tick, and leaves Skip a plain skip', async () => {
      const r = await render();
      await r.push([]);
      await r.habits([
        habitDoc('journal', { name: 'Journal', answer: 'note', template: 'tj' }),
        habitDoc('mood', { name: 'Mood', answer: 'choice', choices: ['calm', 'low'] }),
      ]);
      const logNote = vi.spyOn(r.habitsService, 'logNote').mockReturnValue(undefined);
      buttonNamed(r.el, 'Done: Journal')!.click();
      expect(logNote).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'journal' }),
        '2026-10-06',
      );
      buttonNamed(r.el, 'Skip: Mood')!.click();
      expect(r.api.set.mock.lastCall![2]).toMatchObject({
        days: { '06': { state: 'skipped', answer: 'DELETE', noteId: 'DELETE' } },
      });
    });
  });
});
