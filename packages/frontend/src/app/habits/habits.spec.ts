import { TestBed } from '@angular/core/testing';
import { ModulesService } from '../modules/modules.service';
import { type FakeHabitsApi, type FakeModules, habitDoc } from '../testing/fakes';
import { HOUR, NOW, buttonNamed, renderWithReminders } from '../testing/reminders';
import { habitsConfig } from '@mossgoblin/schema';
import { PushService } from '../push/push.service';
import type { FakePush } from '../testing/fakes';
import { dayState, habitWhen, nudgeHint, streakLine } from './habit-lines';
import { Habits } from './habits';
import { HABITS_API } from './habits.service';

const DAY = 24 * HOUR;

async function render({ on = true, loaded = true } = {}) {
  const r = await renderWithReminders(Habits, () => {
    const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
    modules.loaded.set(loaded);
  });
  const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
  if (on) modules.set('habits', true);
  await r.fixture.whenStable();
  const api = TestBed.inject(HABITS_API) as FakeHabitsApi;
  return {
    ...r,
    api,
    modules,
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

  it('says nothing of the switch until the modules are read (review of #328)', async () => {
    const r = await render({ on: false, loaded: false });
    expect(r.el.textContent).not.toContain('switched off');
    expect(r.el.querySelector('[role="status"]')?.textContent).toBe('Loading…');
    expect(buttonNamed(r.el, 'Add a habit')).toBeUndefined();
    r.modules.set('habits', true);
    r.modules.loaded.set(true);
    await r.fixture.whenStable();
    expect(r.el.textContent).not.toContain('Loading…');
    expect(buttonNamed(r.el, 'Add a habit')).toBeDefined();
  });

  it('keeps the focus on the screen after Undo, Archive and Unarchive (review of #328)', async () => {
    const r = await render();
    await r.habits([habitDoc('floss', { name: 'Floss', createdAt: NOW - 3 * DAY })]);
    buttonNamed(r.el, 'Skip yesterday: Floss')!.click();
    await r.fixture.whenStable();
    const undo = buttonNamed(r.el, 'Undo')!;
    undo.focus();
    undo.click();
    await r.fixture.whenStable();
    expect(buttonNamed(r.el, 'Undo')).toBeUndefined();
    expect(document.activeElement).toBe(buttonNamed(r.el, 'Done yesterday: Floss'));

    buttonNamed(r.el, 'Edit Floss')!.click();
    await r.fixture.whenStable();
    buttonNamed(r.el, 'Archive')!.click();
    await r.fixture.whenStable();
    r.api.pushHabits([habitDoc('floss', { name: 'Floss', archived: true })]);
    await r.fixture.whenStable();
    expect(document.activeElement).toBe(buttonNamed(r.el, 'Unarchive Floss'));
    buttonNamed(r.el, 'Unarchive Floss')!.click();
    await r.fixture.whenStable();
    r.api.pushHabits([habitDoc('floss', { name: 'Floss' })]);
    await r.fixture.whenStable();
    expect(document.activeElement).toBe(buttonNamed(r.el, 'Edit Floss'));
  });

  it('shows the streak known while a further month is read, as at least (review of #328)', async () => {
    const r = await render();
    const days = Object.fromEntries(
      ['01', '02', '03', '04', '05', '06'].map((d) => [d, { state: 'done' as const }]),
    );
    r.api.pushHabits([habitDoc('floss', { name: 'Floss', createdAt: NOW - 90 * DAY })]);
    await r.fixture.whenStable();
    // NOW is Tuesday the 6th: the strip reaches September, which is
    // heard; the streak runs past its first day, so August is read.
    r.api.pushLog('floss_2026-10', days);
    r.api.pushLog(
      'floss_2026-09',
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          String(i + 1).padStart(2, '0'),
          { state: 'done' as const },
        ]),
      ),
    );
    await r.fixture.whenStable();
    expect([...r.api.logs.keys()]).toContain('floss_2026-08');
    expect(card(r.el, 'Floss').querySelector('.meta')?.textContent).toBe(
      'Streak: at least 36 days',
    );
    r.api.pushLog('floss_2026-08');
    await r.fixture.whenStable();
    expect(card(r.el, 'Floss').querySelector('.meta')?.textContent).toBe('Streak: 36 days');
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

  it('nudges only with a time, asks for notifications the first time, and says so on the line', async () => {
    const r = await render();
    const push = TestBed.inject(PushService) as unknown as FakePush;
    push.state.set('off');
    await r.habits([habitDoc('floss', { name: 'Floss' })]);
    buttonNamed(r.el, 'Edit Floss')!.click();
    await r.fixture.whenStable();
    const form = r.el.querySelector<HTMLElement>('form[aria-label="Edit Floss"]')!;
    const nudge = () => form.querySelector<HTMLInputElement>('input[name="nudge"]')!;
    expect(nudge().getAttribute('role')).toBe('switch');
    expect(nudge().disabled).toBe(true);
    expect(form.textContent).toContain('A nudge needs a time of day.');

    type(form, 'input[name="time"]', '21:00');
    await r.fixture.whenStable();
    expect(nudge().disabled).toBe(false);
    expect(form.textContent).toContain('One push at 21:00 if not logged by then.');
    nudge().click();
    await r.fixture.whenStable();
    // The first time, this device's notifications, through Settings' path.
    expect(push.enable).toHaveBeenCalledTimes(1);
    buttonNamed(form, 'Save')!.click();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ time: '21:00', nudge: true });

    r.api.pushHabits([habitDoc('floss', { name: 'Floss', time: '21:00', nudge: true })]);
    await r.fixture.whenStable();
    expect(card(r.el, 'Floss').querySelector('.meta')?.textContent).toContain('21:00 · Nudge on');

    // On already: switched off alone, the time stays and nothing is asked.
    buttonNamed(r.el, 'Edit Floss')!.click();
    await r.fixture.whenStable();
    const again = r.el.querySelector<HTMLElement>('form[aria-label="Edit Floss"]')!;
    const off = again.querySelector<HTMLInputElement>('input[name="nudge"]')!;
    expect(off.checked).toBe(true);
    off.click();
    await r.fixture.whenStable();
    buttonNamed(again, 'Save')!.click();
    expect(r.api.set.mock.lastCall![2]).toEqual({ nudge: false, updatedAt: expect.anything() });
    expect(push.enable).toHaveBeenCalledTimes(1);
  });

  it('turns the nudge off with the time cleared, and points to Settings when blocked', async () => {
    const r = await render();
    const push = TestBed.inject(PushService) as unknown as FakePush;
    push.state.set('blocked');
    await r.habits([habitDoc('floss', { name: 'Floss', time: '21:00', nudge: true })]);
    buttonNamed(r.el, 'Edit Floss')!.click();
    await r.fixture.whenStable();
    const form = r.el.querySelector<HTMLElement>('form[aria-label="Edit Floss"]')!;
    expect(form.querySelector('a[href="/settings/notifications"]')?.textContent).toContain(
      'Settings, Notifications',
    );
    type(form, 'input[name="time"]', '');
    await r.fixture.whenStable();
    expect(form.querySelector<HTMLInputElement>('input[name="nudge"]')!.disabled).toBe(true);
    buttonNamed(form, 'Save')!.click();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ time: 'DELETE', nudge: false });
    expect(push.enable).not.toHaveBeenCalled();
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
    expect(streakLine('daily', 30, false)).toBe('Streak: at least 30 days');
  });

  it('says when a nudge goes, held through the quiet hours or not at all', () => {
    const config = habitsConfig({});
    expect(nudgeHint('daily', '', config)).toBe('A nudge needs a time of day.');
    expect(nudgeHint('daily', '07:30', config)).toBe('One push at 07:30 if not logged by then.');
    expect(nudgeHint('daily', '05:00', config)).toBe(
      'One push at 06:00, when the quiet hours (22:00 to 06:00) end, if not logged by then.',
    );
    expect(nudgeHint('daily', '23:00', config)).toBe(
      'No push: 23:00 is in the quiet hours (22:00 to 06:00), which end after its day does.',
    );
    expect(nudgeHint('weekly', '07:30', config)).toBe('Nudges are for daily habits for now.');
    expect(habitWhen({ schedule: 'daily', time: '07:30', nudge: true }, config)).toBe(
      '07:30 · Nudge on',
    );
    expect(habitWhen({ schedule: 'daily', nudge: true }, config)).toBe('');
  });

  it('puts on a habit’s line only the nudge its Edit hint says will go (review of #330)', () => {
    const config = habitsConfig({});
    const daily = { schedule: 'daily', nudge: true } as const;
    expect(habitWhen({ ...daily, time: '05:00' }, config)).toBe('05:00 · Nudge at 06:00');
    expect(habitWhen({ ...daily, time: '22:30' }, config)).toBe('22:30');
    expect(habitWhen({ ...daily, time: '21:00', nudge: false }, config)).toBe('21:00');
    expect(habitWhen({ schedule: 'weekly', time: '21:00', nudge: true }, config)).toBe(
      'This week · 21:00',
    );
    expect(habitWhen({ schedule: 'monthly', time: '21:00', nudge: true }, config)).toBe(
      'This month · 21:00',
    );
    // Quiet hours set otherwise move the line with the hint.
    const noon = habitsConfig({ quietFrom: '12:00', quietTo: '14:00' });
    expect(habitWhen({ ...daily, time: '22:30' }, noon)).toBe('22:30 · Nudge on');
    expect(habitWhen({ ...daily, time: '13:00' }, noon)).toBe('13:00 · Nudge at 14:00');
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
