import { TestBed } from '@angular/core/testing';
import { ModulesService } from '../modules/modules.service';
import { RightNow } from '../reminders/right-now';
import { type FakeHabitsApi, type FakeModules, habitDoc, reminderDoc } from '../testing/fakes';
import { HOUR, NOW, buttonNamed, renderWithReminders } from '../testing/reminders';
import { HABITS_API } from './habits.service';

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
});
