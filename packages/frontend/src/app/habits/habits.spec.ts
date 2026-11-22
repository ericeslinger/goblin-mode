import { TestBed } from '@angular/core/testing';
import { ModulesService } from '../modules/modules.service';
import { type FakeHabitsApi, type FakeModules, habitDoc } from '../testing/fakes';
import { HOUR, NOW, buttonNamed, renderWithReminders } from '../testing/reminders';
import { habitsConfig } from '@mossgoblin/schema';
import { PushService } from '../push/push.service';
import type { FakePush } from '../testing/fakes';
import { dayState, habitWhen, nudgeHint, ordinal, periodLine, streakLine } from './habit-lines';
import { Habits } from './habits';
import { HABITS_API, HabitsService } from './habits.service';
import { newDataKey, sealHabitAnswer } from '@mossgoblin/schema';
import { NoteKeyService } from '../notes/note-key.service';
import { NotesService } from '../notes/notes.service';
import type { FakeNoteKeys, FakeNotes } from '../testing/fakes';
import { answerWords, latelyLine } from './habit-lines';

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
      logs: Record<
        string,
        Record<string, { state: 'done' | 'skipped'; at?: number; answer?: string; noteId?: string }>
      > = {},
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
    expect(c.querySelector('.period')?.textContent).toBe('Done this week, yesterday');
    // Nothing to log today: no Today row at all, nor yesterday's, the
    // week being one period.
    expect(c.querySelector('[role="group"]')).toBeNull();
    expect(c.querySelector('.meta')?.textContent).toBe('Once a week · Streak: 1 week');
    // The strip: the week from Monday the 5th; the week before missed.
    const said = [...c.querySelectorAll('.strip li .visually-hidden')].map((d) => d.textContent);
    expect(said).toEqual([
      expect.stringMatching(/^Wed 30 Sept?: missed$/),
      'Thu 1 Oct: missed',
      'Fri 2 Oct: missed',
      'Sat 3 Oct: missed',
      'Sun 4 Oct: missed',
      'Mon 5 Oct: done',
      'Tue 6 Oct: settled that week',
    ]);
  });

  it('adds a habit once a week or once a month (step 5 of #324)', async () => {
    const r = await render();
    await r.habits([]);
    buttonNamed(r.el, 'Add your first habit')!.click();
    await r.fixture.whenStable();
    const form = r.el.querySelector<HTMLElement>('form[aria-label="New habit"]')!;
    const select = form.querySelector<HTMLSelectElement>('select[name="schedule"]')!;
    expect(select.closest('label')?.textContent).toContain('How often');
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Every day',
      'Once a week',
      'Once a month',
    ]);
    expect(select.value).toBe('daily');
    type(form, 'input[name="name"]', 'Gutters');
    select.value = 'monthly';
    select.dispatchEvent(new Event('change'));
    await r.fixture.whenStable();
    buttonNamed(form, 'Add')!.click();
    expect(r.api.set.mock.lastCall![2]).toMatchObject({ name: 'Gutters', schedule: 'monthly' });
    await r.fixture.whenStable();
    // The form opens again at Every day.
    buttonNamed(r.el, 'Add a habit')!.click();
    await r.fixture.whenStable();
    expect(r.el.querySelector<HTMLSelectElement>('select[name="schedule"]')!.value).toBe('daily');
  });

  it('changes how often in Edit, saying what is logged stays, and nothing else', async () => {
    const r = await render();
    await r.habits([habitDoc('floss', { name: 'Floss', time: '21:00', nudge: true })]);
    buttonNamed(r.el, 'Edit Floss')!.click();
    await r.fixture.whenStable();
    const form = r.el.querySelector<HTMLElement>('form[aria-label="Edit Floss"]')!;
    const select = form.querySelector<HTMLSelectElement>('select[name="schedule"]')!;
    expect(select.value).toBe('daily');
    expect(form.textContent).not.toContain('read again by the new schedule');
    select.value = 'weekly';
    select.dispatchEvent(new Event('change'));
    await r.fixture.whenStable();
    expect(form.textContent).toContain('What is logged stays, read again by the new schedule.');
    // The hint is for the schedule chosen, before it is saved: the last
    // day of the week (Eric, 2026-11-22).
    expect(form.textContent).toContain('One push on Sunday at 21:00 if not done this week.');
    r.api.set.mockClear();
    buttonNamed(form, 'Save')!.click();
    expect(r.api.set.mock.calls.map((c) => c[2])).toEqual([
      { schedule: 'weekly', updatedAt: expect.anything() },
    ]);
  });

  it('says how a month stands, done on a day, skipped, or not yet (step 5 of #324)', async () => {
    const r = await render();
    const made = { schedule: 'monthly', createdAt: NOW - 60 * DAY };
    await r.habits(
      [
        habitDoc('rent', { name: 'Rent', ...made }),
        habitDoc('gutters', { name: 'Gutters', ...made }),
        habitDoc('bins', { name: 'Bins', ...made }),
      ],
      {
        'rent_2026-10': { '03': { state: 'done' } },
        'gutters_2026-10': { '06': { state: 'skipped' } },
      },
    );
    expect(card(r.el, 'Rent').querySelector('.period')?.textContent).toBe(
      'Done this month, on the 3rd',
    );
    expect(card(r.el, 'Gutters').querySelector('.period')?.textContent).toBe(
      'Skipped this month, today',
    );
    // Skipped today: its Today row stays, Skip pressed, to clear it.
    expect(
      buttonNamed(card(r.el, 'Gutters'), 'Skip today: Gutters')!.getAttribute('aria-pressed'),
    ).toBe('true');
    const bins = card(r.el, 'Bins');
    expect(bins.querySelector('.period')?.textContent).toBe('Not done yet this month');
    expect(bins.querySelector('.meta')?.textContent).toBe('Once a month · No streak yet');
    expect(card(r.el, 'Rent').querySelector('.meta')?.textContent).toBe(
      'Once a month · Streak: 1 month',
    );
  });

  it('reads a week start other than Monday from the module’s setting', async () => {
    const r = await render();
    // From Sunday: the week of Sun 4 Oct, done on Monday the 5th.
    r.modules.configureHabits({ weekStart: 'Sun' });
    await r.habits(
      [habitDoc('pots', { name: 'Pots', schedule: 'weekly', createdAt: NOW - 30 * DAY })],
      { 'pots_2026-10': { '05': { state: 'done' } } },
    );
    const said = [...card(r.el, 'Pots').querySelectorAll('.strip li .visually-hidden')].map(
      (d) => d.textContent,
    );
    expect(said.slice(-3)).toEqual([
      'Sun 4 Oct: settled that week',
      'Mon 5 Oct: done',
      'Tue 6 Oct: settled that week',
    ]);
    expect(said[3]).toBe('Sat 3 Oct: missed');
  });
});

describe('habit lines', () => {
  it('words a streak by its schedule', () => {
    expect(streakLine('daily', 0)).toBe('No streak yet');
    expect(streakLine('daily', 1)).toBe('Streak: 1 day');
    expect(streakLine('daily', 5)).toBe('Streak: 5 days');
    expect(streakLine('weekly', 2)).toBe('Streak: 2 weeks');
    expect(streakLine('weekly', 3)).toBe('Streak: 3 weeks');
    expect(streakLine('monthly', 1)).toBe('Streak: 1 month');
    expect(streakLine('monthly', 2)).toBe('Streak: 2 months');
    expect(streakLine('daily', 30, false)).toBe('Streak: at least 30 days');
  });

  it('says when a nudge goes, around the quiet hours (Eric, 2026-11-22)', () => {
    const config = habitsConfig({});
    expect(nudgeHint('daily', '', config)).toBe('A nudge needs a time of day.');
    expect(nudgeHint('daily', '07:30', config)).toBe('One push at 07:30 if not logged by then.');
    expect(nudgeHint('daily', '05:00', config)).toBe(
      'One push at 06:00, when the quiet hours (22:00 to 06:00) end, if not logged by then.',
    );
    expect(nudgeHint('daily', '23:00', config)).toBe(
      'One push at 22:00, as the quiet hours (22:00 to 06:00) begin, if not logged by then.',
    );
    expect(nudgeHint('daily', '22:00', config)).toBe('One push at 22:00 if not logged by then.');
    // Weekly and monthly: the last day of the period.
    expect(nudgeHint('weekly', '21:00', config)).toBe(
      'One push on Sunday at 21:00 if not done this week.',
    );
    expect(nudgeHint('weekly', '21:00', habitsConfig({ weekStart: 'Sun' }))).toBe(
      'One push on Saturday at 21:00 if not done this week.',
    );
    expect(nudgeHint('weekly', '23:30', config)).toBe(
      'One push on Sunday at 22:00, as the quiet hours (22:00 to 06:00) begin, if not done this week.',
    );
    expect(nudgeHint('monthly', '09:00', config)).toBe(
      'One push on the last day of the month at 09:00 if not done this month.',
    );
    expect(nudgeHint('monthly', '04:00', config)).toBe(
      'One push on the last day of the month at 06:00, when the quiet hours (22:00 to 06:00) end, if not done this month.',
    );
    expect(habitWhen({ schedule: 'daily', time: '07:30', nudge: true }, config)).toBe(
      '07:30 · Nudge on',
    );
    expect(habitWhen({ schedule: 'daily', nudge: true }, config)).toBe('');
  });

  it('puts on a habit’s line only the nudge its Edit hint says will go (review of #330)', () => {
    const config = habitsConfig({});
    const daily = { schedule: 'daily', nudge: true } as const;
    expect(habitWhen({ ...daily, time: '05:00' }, config)).toBe('05:00 · Nudge at 06:00');
    // Eric, 2026-11-22: sent as the quiet hours begin.
    expect(habitWhen({ ...daily, time: '22:30' }, config)).toBe('22:30 · Nudge at 22:00');
    expect(habitWhen({ ...daily, time: '22:00' }, config)).toBe('22:00 · Nudge on');
    expect(habitWhen({ ...daily, time: '21:00', nudge: false }, config)).toBe('21:00');
    // Eric, 2026-11-22: weekly and monthly on the period's last day.
    expect(habitWhen({ schedule: 'weekly', time: '21:00', nudge: true }, config)).toBe(
      'This week · 21:00 · Nudge on Sunday',
    );
    expect(habitWhen({ schedule: 'weekly', time: '23:00', nudge: true }, config, 'screen')).toBe(
      'Once a week · 23:00 · Nudge Sunday at 22:00',
    );
    expect(habitWhen({ schedule: 'monthly', time: '21:00', nudge: true }, config)).toBe(
      'This month · 21:00 · Nudge on the last day',
    );
    expect(habitWhen({ schedule: 'monthly', time: '05:00', nudge: true }, config, 'screen')).toBe(
      'Once a month · 05:00 · Nudge on the last day at 06:00',
    );
    // Quiet hours set otherwise move the line with the hint.
    const noon = habitsConfig({ quietFrom: '12:00', quietTo: '14:00' });
    expect(habitWhen({ ...daily, time: '22:30' }, noon)).toBe('22:30 · Nudge on');
    expect(habitWhen({ ...daily, time: '13:00' }, noon)).toBe('13:00 · Nudge at 14:00');
  });

  it('names a weekly or monthly habit’s kind: the period on Right Now, how often here', () => {
    const config = habitsConfig({});
    expect(habitWhen({ schedule: 'weekly' }, config)).toBe('This week');
    expect(habitWhen({ schedule: 'weekly' }, config, 'screen')).toBe('Once a week');
    expect(habitWhen({ schedule: 'monthly', time: '09:00' }, config, 'screen')).toBe(
      'Once a month · 09:00',
    );
    expect(habitWhen({ schedule: 'daily', time: '09:00' }, config, 'screen')).toBe('09:00');
  });

  it('says how a week or month stands, by the day that settled it', () => {
    const today = '2026-11-18'; // a Wednesday
    const line = (
      schedule: 'daily' | 'weekly' | 'monthly',
      state: 'done' | 'skipped' | 'none',
      settledOn?: string,
    ) => periodLine({ schedule, state, ...(settledOn ? { settledOn } : {}) }, today);
    expect(line('daily', 'done', today)).toBe('');
    expect(line('weekly', 'none')).toBe('Not done yet this week');
    expect(line('monthly', 'none')).toBe('Not done yet this month');
    expect(line('weekly', 'done', today)).toBe('Done this week, today');
    expect(line('weekly', 'done', '2026-11-17')).toBe('Done this week, yesterday');
    expect(line('weekly', 'skipped', '2026-11-16')).toBe('Skipped this week, on Monday');
    expect(line('monthly', 'done', '2026-11-01')).toBe('Done this month, on the 1st');
    expect(line('monthly', 'done', '2026-11-03')).toBe('Done this month, on the 3rd');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30, 31].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '30th',
      '31st',
    ]);
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
  describe('answers (step 6, 2026-11-22)', () => {
    afterEach(() => localStorage.clear());
    const keys = () => TestBed.inject(NoteKeyService) as unknown as FakeNoteKeys;
    const choose = async (
      r: { fixture: { whenStable(): Promise<unknown> } },
      select: HTMLSelectElement,
      value: string,
    ) => {
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await r.fixture.whenStable();
    };

    it('adds a habit answered with one of a list, its choices edited in place', async () => {
      const r = await render();
      await r.habits([]);
      buttonNamed(r.el, 'Add your first habit')!.click();
      await r.fixture.whenStable();
      const form = r.el.querySelector<HTMLElement>('form[aria-label="New habit"]')!;
      const answer = form.querySelector<HTMLSelectElement>('select[name="answer"]')!;
      expect(answer.closest('label')?.textContent).toContain('Answered with');
      expect([...answer.options].map((o) => o.textContent?.trim())).toEqual([
        'Just done',
        'One of a list',
        'A line of text',
        'A note',
      ]);
      expect(answer.value).toBe('done');
      type(form, 'input[name="name"]', 'Mood');
      await choose(r, answer, 'choice');
      type(form, 'input[aria-label="Choice 1"]', 'calm');
      await r.fixture.whenStable();
      // Two at least, and none twice.
      type(form, 'input[aria-label="Choice 2"]', 'Calm');
      await r.fixture.whenStable();
      expect(form.textContent).toContain('Calm is in the list twice');
      expect(buttonNamed(form, 'Add')!.disabled).toBe(true);
      type(form, 'input[aria-label="Choice 2"]', 'tired');
      buttonNamed(form, 'Add a choice')!.click();
      await r.fixture.whenStable();
      type(form, 'input[aria-label="Choice 3"]', 'cross');
      buttonNamed(form, 'Move choice 3 up')!.click();
      await r.fixture.whenStable();
      buttonNamed(form, 'Remove choice 1')!.click();
      await r.fixture.whenStable();
      expect(buttonNamed(form, 'Add')!.disabled).toBe(false);
      buttonNamed(form, 'Add')!.click();
      expect(r.api.set.mock.lastCall![2]).toMatchObject({
        name: 'Mood',
        answer: 'choice',
        choices: ['cross', 'tired'],
      });
    });

    it('adds a note habit from one of the templates, and says where to make one', async () => {
      const r = await render();
      await r.habits([]);
      buttonNamed(r.el, 'Add your first habit')!.click();
      await r.fixture.whenStable();
      const form = r.el.querySelector<HTMLElement>('form[aria-label="New habit"]')!;
      type(form, 'input[name="name"]', 'Journal');
      await choose(r, form.querySelector<HTMLSelectElement>('select[name="answer"]')!, 'note');
      expect(form.textContent).toContain('No templates yet');
      const notes = TestBed.inject(NotesService) as unknown as FakeNotes;
      notes.notes.set([
        {
          id: 'tj',
          title: 'Feelings journal',
          kind: 'template',
          body: '',
          archived: false,
        } as never,
      ]);
      await r.fixture.whenStable();
      const template = form.querySelector<HTMLSelectElement>('select[name="template"]')!;
      expect([...template.options].map((o) => o.textContent?.trim())).toEqual([
        'Choose a template',
        'Feelings journal',
      ]);
      expect(buttonNamed(form, 'Add')!.disabled).toBe(true);
      await choose(r, template, 'tj');
      buttonNamed(form, 'Add')!.click();
      expect(r.api.set.mock.lastCall![2]).toMatchObject({ answer: 'note', template: 'tj' });
    });

    it('changes what a habit is answered with in Edit, saying what is logged stays', async () => {
      const r = await render();
      await r.habits([habitDoc('walk', { name: 'Walk' })]);
      buttonNamed(r.el, 'Edit Walk')!.click();
      await r.fixture.whenStable();
      const form = r.el.querySelector<HTMLElement>('form[aria-label="Edit Walk"]')!;
      await choose(r, form.querySelector<HTMLSelectElement>('select[name="answer"]')!, 'text');
      expect(form.textContent).toContain('What is logged stays: earlier days keep what they hold.');
      r.api.set.mockClear();
      buttonNamed(form, 'Save')!.click();
      expect(r.api.set.mock.calls.map((c) => c[2])).toEqual([
        { answer: 'text', choices: 'DELETE', template: 'DELETE', updatedAt: expect.anything() },
      ]);
    });

    it('asks a choice habit’s answer on Done, and shows it on the row and lately', async () => {
      const r = await render();
      const key = newDataKey();
      keys().key.set(key);
      const tired = sealHabitAnswer(key, 'u1', 'mood', '2026-10-05', 'choice', 'tired');
      await r.habits(
        [
          habitDoc('mood', {
            name: 'Mood',
            answer: 'choice',
            choices: ['calm', 'tired'],
            createdAt: NOW - 3 * DAY,
          }),
        ],
        { 'mood_2026-10': { '05': { state: 'done', at: NOW - DAY, answer: tired } } },
      );
      const c = card(r.el, 'Mood');
      expect(c.querySelector('.lately')?.textContent).toBe('Lately: yesterday tired');
      expect(c.querySelector('[aria-label="Yesterday, Mood"] .answer')?.textContent).toBe('tired');
      expect(c.querySelector('.strip li:nth-child(6)')?.getAttribute('title')).toBe(
        'Mon 5 Oct: done, tired',
      );
      buttonNamed(c, 'Done today: Mood')!.click();
      await r.fixture.whenStable();
      expect(buttonNamed(c, 'Done today: Mood')!.getAttribute('aria-expanded')).toBe('true');
      const group = c.querySelector<HTMLElement>('[aria-label="Mood today: choose one"]')!;
      expect([...group.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
        'calm',
        'tired',
        'Cancel',
      ]);
      expect(document.activeElement?.textContent?.trim()).toBe('calm');
      buttonNamed(group, 'calm')!.click();
      await r.fixture.whenStable();
      const written = r.api.set.mock.lastCall![2] as { days: Record<string, { answer: string }> };
      expect(written.days['06'].answer.startsWith('mg1.')).toBe(true);
      r.api.pushLog('mood_2026-10', {
        '05': { state: 'done', at: NOW - DAY, answer: tired },
        '06': { state: 'done', at: NOW, answer: written.days['06'].answer },
      });
      await r.fixture.whenStable();
      expect(c.querySelector('[aria-label="Today, Mood"] .answer')?.textContent).toBe('calm');
      expect(c.querySelector('.lately')?.textContent).toBe('Lately: today calm · yesterday tired');
      expect(c.querySelector('app-habit-ask')).toBeNull();
    });

    it('takes a text habit’s line on Enter, empty meaning done, and keeps a draft', async () => {
      const r = await render();
      keys().key.set(newDataKey());
      await r.habits([habitDoc('walk', { name: 'Walk', answer: 'text' })]);
      const c = card(r.el, 'Walk');
      buttonNamed(c, 'Done today: Walk')!.click();
      await r.fixture.whenStable();
      const input = c.querySelector<HTMLInputElement>(
        'input[aria-label="Walk today: a line of text"]',
      )!;
      expect(document.activeElement).toBe(input);
      type(c, 'input[aria-label="Walk today: a line of text"]', 'to the');
      expect(TestBed.inject(HabitsService).draft('walk', '2026-10-06')).toBe('to the');
      type(c, 'input[aria-label="Walk today: a line of text"]', '');
      input.form!.requestSubmit();
      await r.fixture.whenStable();
      expect(r.api.set.mock.lastCall![2]).toMatchObject({
        days: { '06': { state: 'done', answer: 'DELETE' } },
      });
    });

    it('opens a note habit’s entry on Done, and links to it once logged', async () => {
      const r = await render();
      await r.habits([habitDoc('journal', { name: 'Journal', answer: 'note', template: 'tj' })], {
        'journal_2026-10': { '06': { state: 'done', at: NOW, noteId: 'entry1' } },
      });
      const c = card(r.el, 'Journal');
      const link = c.querySelector<HTMLAnchorElement>('[aria-label="Today, Journal"] a.answer')!;
      expect(link.textContent?.trim()).toBe('Open the entry');
      expect(link.getAttribute('href')).toBe('/n/entry1');
      const service = TestBed.inject(HabitsService);
      const logNote = vi.spyOn(service, 'logNote').mockReturnValue(undefined);
      r.api.pushLog('journal_2026-10', {});
      await r.fixture.whenStable();
      buttonNamed(c, 'Done today: Journal')!.click();
      expect(logNote).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'journal' }),
        '2026-10-06',
      );
    });

    it('words an answer for a strip day, and the last week’s choices newest first', () => {
      expect(answerWords({ text: 'calm' })).toBe('calm');
      expect(answerWords({ sealed: true })).toBe('answer sealed');
      expect(answerWords({ noteId: 'n' })).toBe('with a note');
      expect(answerWords(undefined)).toBe('');
      expect(
        latelyLine(
          [
            { day: '2026-10-01', answer: { text: 'ok' } },
            { day: '2026-10-02' },
            { day: '2026-10-05', answer: { sealed: true } },
            { day: '2026-10-06', answer: { text: 'calm' } },
          ],
          '2026-10-06',
        ),
      ).toBe('Lately: today calm · yesterday answer sealed · Thu ok');
      expect(latelyLine([{ day: '2026-10-06' }], '2026-10-06')).toBe('');
    });
  });
});
