import { TestBed } from '@angular/core/testing';
import { ModulesService } from '../modules/modules.service';
import { type FakeHabitsApi, type FakeModules, habitDoc } from '../testing/fakes';
import { HOUR, NOW, buttonNamed, renderWithReminders } from '../testing/reminders';
import { dayState, streakLine } from './habit-lines';
import { Habits } from './habits';
import { HABITS_API } from './habits.service';

const DAY = 24 * HOUR;

async function render({ on = true } = {}) {
  const r = await renderWithReminders(Habits);
  const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
  if (on) modules.set('habits', true);
  await r.fixture.whenStable();
  const api = TestBed.inject(HABITS_API) as FakeHabitsApi;
  return {
    ...r,
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

const card = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLElement>('app-habit-card')].find(
    (c) => c.querySelector('h2, h3')?.textContent?.trim() === name,
  )!;

function type(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('The Habits screen (#324)', () => {
  it('says where to switch it on while the module is off', async () => {
    const r = await render({ on: false });
    expect(r.el.textContent).toContain('Habits is a module that is switched off.');
    expect(r.el.querySelector('a[href="/settings/modules"]')).not.toBeNull();
    expect(buttonNamed(r.el, 'Add a habit')).toBeUndefined();
  });

  it('says what a habit is with none yet, and adds the first', async () => {
    const r = await render();
    await r.habits([]);
    expect(r.el.textContent).toContain('A habit is something you mean to do every day');
    buttonNamed(r.el, 'Add your first habit')!.click();
    await r.fixture.whenStable();
    type(r.el, 'input[name="name"]', 'Stretch');
    type(r.el, 'input[name="time"]', '07:30');
    await r.fixture.whenStable();
    buttonNamed(r.el, 'Add')!.click();
    await r.fixture.whenStable();
    const [, path, data] = r.api.set.mock.lastCall!;
    expect(path).toMatch(/^users\/u1\/habits\/[A-Za-z0-9]{20}$/);
    expect(data).toMatchObject({ name: 'Stretch', time: '07:30', schedule: 'daily' });
    expect(r.el.querySelector('form')).toBeNull();
  });

  it('shows each day of the strip with words, not colour alone, and the streak', async () => {
    const r = await render();
    await r.habits([habitDoc('floss', { name: 'Floss', createdAt: NOW - 10 * DAY })], {
      'floss_2026-10': {
        '03': { state: 'done' },
        '04': { state: 'skipped' },
        '06': { state: 'done' },
      },
    });
    const c = card(r.el, 'Floss');
    const days = [...c.querySelectorAll('.strip li')];
    const said = days.map((d) => d.querySelector('.visually-hidden')?.textContent);
    // September is "Sep" or "Sept" by the platform's locale data.
    expect(said[0]).toMatch(/^Wed 30 Sept?: missed$/);
    expect(said.slice(1)).toEqual([
      'Thu 1 Oct: missed',
      'Fri 2 Oct: missed',
      'Sat 3 Oct: done',
      'Sun 4 Oct: skipped',
      // Yesterday, empty but still loggable: not missed yet.
      'Mon 5 Oct: not logged yet',
      'Tue 6 Oct: done',
    ]);
    expect(days.map((d) => d.querySelector('.mark')?.textContent)).toEqual([
      '×',
      '×',
      '×',
      '✓',
      '–',
      '',
      '✓',
    ]);
    // Today done; yesterday empty, passed over; the skip neither counts nor breaks.
    expect(c.querySelector('.meta')?.textContent).toBe('Streak: 2 days');
    expect(buttonNamed(c, 'Done today: Floss')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('ticks today, clears it with a second press, and logs yesterday', async () => {
    const r = await render();
    await r.habits([habitDoc('floss', { name: 'Floss', createdAt: NOW - 3 * DAY })]);
    const c = card(r.el, 'Floss');
    buttonNamed(c, 'Done today: Floss')!.click();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ days: { '06': { state: 'done' } } });
    r.api.pushLog('floss_2026-10', { '06': { state: 'done' } });
    await r.fixture.whenStable();
    buttonNamed(c, 'Done today: Floss')!.click();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ days: { '06': 'DELETE' } });
    buttonNamed(c, 'Skip yesterday: Floss')!.click();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ days: { '05': { state: 'skipped' } } });
  });

  it('renames, sets a time and archives; Archived keeps the strip and unarchives', async () => {
    const r = await render();
    await r.habits([habitDoc('floss', { name: 'Floss' })]);
    buttonNamed(r.el, 'Edit Floss')!.click();
    await r.fixture.whenStable();
    const form = r.el.querySelector<HTMLElement>('form[aria-label="Edit Floss"]')!;
    type(form, 'input[name="name"]', 'Floss well');
    type(form, 'input[name="time"]', '21:30');
    await r.fixture.whenStable();
    buttonNamed(form, 'Save')!.click();
    const writes = r.api.set.mock.calls.map((c) => [c[1], c[2]]);
    expect(writes.slice(-2)).toEqual([
      ['users/u1/habits/floss', expect.objectContaining({ name: 'Floss well' })],
      ['users/u1/habits/floss', expect.objectContaining({ time: '21:30' })],
    ]);
    buttonNamed(r.el, 'Edit Floss')!.click();
    await r.fixture.whenStable();
    buttonNamed(r.el, 'Archive')!.click();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ archived: true });

    r.api.pushHabits([habitDoc('floss', { name: 'Floss', archived: true })]);
    await r.fixture.whenStable();
    const archived = r.el.querySelector('section[aria-labelledby="habits-archived"]')!;
    expect(archived.querySelector('h3')?.textContent?.trim()).toBe('Floss');
    expect(archived.querySelectorAll('.strip li')).toHaveLength(7);
    expect(r.el.querySelector('ul[aria-label="Habits"]')).toBeNull();
    buttonNamed(archived as HTMLElement, 'Unarchive Floss')!.click();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ archived: false });
  });

  it('shows a weekly habit settled on another day as done this week', async () => {
    const r = await render();
    // Done Monday the 5th; today is Tuesday.
    await r.habits(
      [habitDoc('pots', { name: 'Pots', schedule: 'weekly', createdAt: NOW - 30 * DAY })],
      {
        'pots_2026-10': { '05': { state: 'done' } },
      },
    );
    const c = card(r.el, 'Pots');
    expect(c.textContent).toContain('Done this week');
    expect(buttonNamed(c, 'Done today: Pots')).toBeUndefined();
    expect(c.querySelector('.meta')?.textContent).toBe('This week · Streak: 1 week');
  });
});

describe('habit lines', () => {
  it('words a streak by its schedule', () => {
    expect(streakLine('daily', 0)).toBe('No streak yet');
    expect(streakLine('daily', 1)).toBe('Streak: 1 day');
    expect(streakLine('daily', 5)).toBe('Streak: 5 days');
    expect(streakLine('weekly', 2)).toBe('Streak: 2 weeks');
  });

  it('gives every strip state a mark or words of its own', () => {
    const states = ['done', 'skipped', 'covered', 'missed', 'open', 'before'] as const;
    const words = states.map((s) => dayState(s, 'daily').words);
    expect(new Set(words).size).toBe(states.length);
  });

  it('says a write the server refused, naming the habit (review of #327)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await render();
    await r.habits([habitDoc('floss', { name: 'Floss', createdAt: NOW - 3 * DAY })]);
    r.api.set.mockReturnValueOnce(Promise.reject(new Error('denied')));
    buttonNamed(r.el, 'Done yesterday: Floss')!.click();
    await r.fixture.whenStable();
    const alert = r.el.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain('Floss could not be saved for yesterday.');
    expect(buttonNamed(r.el, 'Try again: Floss')).toBeDefined();
    buttonNamed(r.el, 'Dismiss: Floss')!.click();
    await r.fixture.whenStable();
    expect(alert.textContent?.trim()).toBe('');
  });
});
