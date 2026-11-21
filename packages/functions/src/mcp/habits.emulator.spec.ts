import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '@mossgoblin/schema';
import { testKeyFor } from '../testing/test-key';
import { NotesTools } from './tools';

// The assistant's Habits tools (#324 step 3, 2026-11-21), against the
// Firestore emulator under their own project id, as tools.emulator.spec
// runs (inside `npm run e2e`). A habit's name and its log hold no note
// text, so nothing here is sealed.
const PROJECT = 'demo-mossgoblin-habits';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'mcp-habits-spec');
let db: Firestore;
/** 11:00 on Saturday Nov 21 in Los Angeles. */
const T = Date.parse('2026-11-21T19:00:00Z');
const LA = 'America/Los_Angeles';

beforeAll(() => {
  process.env['FIRESTORE_EMULATOR_HOST'] = HOST;
  db = getFirestore(app);
});
beforeEach(async () => {
  const res = await fetch(
    `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`could not clear the emulator: ${res.status}`);
});
afterAll(() => deleteApp(app));

const tools = (now = T) => new NotesTools(db, 'u1', () => now, undefined, undefined, testKeyFor);
const habitsOn = (config: Record<string, unknown> = {}) =>
  db.doc('users/u1/settings/modules').set({
    habits: { enabled: true, config },
    updatedAt: Timestamp.fromMillis(T),
  });
const at = (ms: number) => Timestamp.fromMillis(ms);

/** A habit as the app makes it (HabitsService.add). */
async function appHabit(id: string, name: string, over: Record<string, unknown> = {}) {
  await db.doc(`users/u1/habits/${id}`).set({
    name,
    schedule: 'daily',
    tz: LA,
    answer: 'done',
    nudge: false,
    archived: false,
    createdAt: at(Date.parse('2026-09-01T12:00:00Z')),
    updatedAt: at(Date.parse('2026-09-01T12:00:00Z')),
    createdBy: 'user',
    ...over,
  });
}

/** Days logged as the app writes a tick: one merged day of the month's log. */
async function appTick(habit: string, day: string, state: 'done' | 'skipped', extra = {}) {
  const month = day.slice(0, 7);
  await db.doc(`users/u1/habitLogs/${habit}_${month}`).set(
    {
      habit,
      month,
      days: { [day.slice(8)]: { state, at: at(T - 3600_000), ...extra } },
      updatedAt: at(T - 3600_000),
    },
    { merge: true },
  );
}
async function appTicks(habit: string, from: string, to: string) {
  for (let d = from; d <= to; d = addDays(d, 1)) await appTick(habit, d, 'done');
}

const log = async (id: string) => (await db.doc(`users/u1/habitLogs/${id}`).get()).data();
/** The activity entries, by summary: written in one millisecond, they have no order. */
const runs = async () =>
  (await db.collection('users/u1/activity').get()).docs
    .map((d) => d.data())
    .sort((a, b) => String(a['summary']).localeCompare(String(b['summary'])));

describe('the Habits tools (#324 step 3)', () => {
  it('refuses every Habits tool while the module is off', async () => {
    const t = tools();
    await appHabit('h1', 'Floss');
    const off = /Habits is switched off in Eric's settings \(Settings, Modules\)/;
    await expect(t.createHabit({ name: 'Floss', timeZone: LA })).rejects.toThrow(off);
    await expect(t.listHabits({})).rejects.toThrow(off);
    await expect(t.updateHabit({ habit: 'h1', archived: true })).rejects.toThrow(off);
    await expect(t.logHabit({ habit: 'h1', state: 'done' })).rejects.toThrow(off);
    expect(await log('h1_2026-11')).toBeUndefined();
    // get_context says nothing of habits then.
    expect(await t.getContext({ habits: true })).not.toHaveProperty('habits');
  });

  it('makes a habit in the stored shape, and records it for What assistants changed', async () => {
    await habitsOn();
    const made = await tools().createHabit({
      name: '  Drink metamucil for fiber ',
      time: '11:00',
      timeZone: LA,
    });
    expect(made).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9]{20}$/),
      name: 'Drink metamucil for fiber',
      schedule: 'daily',
      time: '11:00',
      timeZone: LA,
      answer: 'done',
      nudge: false,
      archived: false,
      createdBy: 'claude',
      agent: 'Claude',
    });
    const stored = (await db.doc(`users/u1/habits/${made.id}`).get()).data();
    expect(stored).toEqual({
      name: 'Drink metamucil for fiber',
      schedule: 'daily',
      time: '11:00',
      tz: LA,
      answer: 'done',
      nudge: false,
      archived: false,
      createdAt: at(T),
      updatedAt: at(T),
      createdBy: 'claude',
      agent: 'Claude',
    });
    expect(await runs()).toEqual([
      expect.objectContaining({
        tool: 'create_habit',
        summary: 'Made the habit Drink metamucil for fiber',
        notes: [],
        reminders: [],
        agent: 'Claude',
      }),
    ]);
  });

  it('refuses a name an unarchived habit has, a nudge with no time, and an unknown zone', async () => {
    await habitsOn();
    const t = tools().as('Gemini CLI');
    const first = await t.createHabit({ name: 'Drink metamucil for fiber', timeZone: LA });
    expect(first.agent).toBe('Gemini CLI');
    await expect(
      t.createHabit({ name: ' drink METAMUCIL for fiber', timeZone: LA }),
    ).rejects.toThrow(/already has a habit named Drink metamucil for fiber .*update_habit/);
    await expect(t.createHabit({ name: 'Run', nudge: true, timeZone: LA })).rejects.toThrow(
      /a nudge needs a time of day/,
    );
    await expect(t.createHabit({ name: 'Run', timeZone: 'Not/AZone' })).rejects.toThrow(
      /unknown time zone Not\/AZone/,
    );
    await expect(t.createHabit({ name: 'Run', time: '7am', timeZone: LA })).rejects.toThrow(
      /HH:MM/,
    );
    // A nudge on: the result says what is sent, and that a weekly one waits.
    const nudged = await t.createHabit({
      name: 'Run',
      schedule: 'weekly',
      time: '07:00',
      nudge: true,
      timeZone: LA,
    });
    expect(nudged).toMatchObject({ schedule: 'weekly', nudge: true });
    expect(nudged.nudgeNote).toMatch(/weekly and monthly habits are not nudged yet/);
    // Archived, its name is free again.
    await t.updateHabit({ habit: first.id, archived: true });
    const again = await t.createHabit({ name: 'Drink metamucil for fiber', timeZone: LA });
    expect(again.id).not.toBe(first.id);
    expect((await db.collection('users/u1/habits').get()).size).toBe(3);
  });

  it('lists each habit with due, today, yesterday and a streak read across months', async () => {
    await habitsOn();
    // Mon Nov 2 in Los Angeles.
    const now = Date.parse('2026-11-02T20:00:00Z');
    await appHabit('floss', 'Floss', { time: '21:00' });
    // Done every day from Sep 25, Nov 1 skipped, done today: the streak
    // runs past the two months the day needs, so September is read too.
    await appTicks('floss', '2026-09-25', '2026-10-31');
    await appTick('floss', '2026-11-01', 'skipped');
    await appTick('floss', '2026-11-02', 'done');
    await appHabit('moss', 'Water the moss', { schedule: 'weekly' });
    await appTick('moss', '2026-10-28', 'done');
    await appHabit('mood', 'Mood', { answer: 'choice', choices: ['good', 'low'] });
    await appHabit('old', 'Old habit', { archived: true });
    await db.doc('users/u1/habits/bad').set({ name: 'No schedule' });

    const listed = await tools(now).listHabits({});
    // By time of day, then name.
    expect(listed.map((h) => h.name)).toEqual(['Floss', 'Mood', 'Water the moss']);
    expect(listed[0]).toMatchObject({
      id: 'floss',
      time: '21:00',
      timeZone: LA,
      due: true,
      today: { date: '2026-11-02', state: 'done' },
      yesterday: { date: '2026-11-01', state: 'skipped' },
      // Sep 25 to Oct 31 is 37 days, and today.
      streak: { count: 38, unit: 'days' },
    });
    expect(listed[0]).not.toHaveProperty('thisPeriod');
    expect(listed[0].streak).not.toHaveProperty('capped');
    // A weekly habit: due all week until done; last week, which
    // yesterday was in, done on its Wednesday.
    expect(listed[2]).toMatchObject({
      schedule: 'weekly',
      due: true,
      thisPeriod: 'none',
      today: { state: 'none' },
      streak: { count: 1, unit: 'weeks' },
    });
    // Another kind is listed with its kind.
    expect(listed[1]).toMatchObject({ answer: 'choice', due: true, streak: { count: 0 } });

    const all = await tools(now).listHabits({ includeArchived: true });
    expect(all.at(-1)).toMatchObject({ name: 'Old habit', archived: true, due: false });
  });

  it('changes a habit by its name, archives it, and never deletes', async () => {
    await habitsOn();
    await appHabit('floss', 'Floss');
    await appHabit('run', 'Run', { archived: true });
    const t = tools();
    await expect(t.updateHabit({ habit: 'floss' })).rejects.toThrow(/say what to change/);
    await expect(t.updateHabit({ habit: 'Swim', name: 'Swim more' })).rejects.toThrow(
      /no habit Swim/,
    );
    await expect(t.updateHabit({ habit: 'FLOSS', time: '21:00' })).rejects.toThrow(
      /timeZone .* is required with time/,
    );
    const renamed = await t.updateHabit({
      habit: ' FLOSS ',
      name: 'Floss nightly',
      time: '21:00',
      timeZone: 'Europe/London',
      nudge: true,
    });
    expect(renamed).toMatchObject({
      changed: true,
      id: 'floss',
      name: 'Floss nightly',
      time: '21:00',
      timeZone: 'Europe/London',
      nudge: true,
      createdBy: 'user',
    });
    await expect(t.updateHabit({ habit: 'floss', time: null })).rejects.toThrow(
      /a nudge needs a time of day/,
    );
    expect(
      await t.updateHabit({ habit: 'Floss nightly', time: null, nudge: false }),
    ).not.toHaveProperty('time');
    expect((await db.doc('users/u1/habits/floss').get()).data()).toMatchObject({
      name: 'Floss nightly',
      tz: 'Europe/London',
      nudge: false,
      createdBy: 'user',
      updatedAt: at(T),
    });
    expect((await db.doc('users/u1/habits/floss').get()).get('time')).toBeUndefined();
    // Nothing to change: said, not written.
    expect(await t.updateHabit({ habit: 'floss', schedule: 'daily' })).toMatchObject({
      changed: false,
    });
    // An archived habit's name brought back over a live one's is refused.
    await t.updateHabit({ habit: 'floss', name: 'Run' });
    await expect(t.updateHabit({ habit: 'run', archived: false })).rejects.toThrow(
      /already has a habit named Run \(floss\)/,
    );
    await t.updateHabit({ habit: 'floss', archived: true });
    expect(await t.updateHabit({ habit: 'run', archived: false })).toMatchObject({
      id: 'run',
      archived: false,
    });
    expect((await db.collection('users/u1/habits').get()).size).toBe(2);
    expect((await runs()).map((r) => [r['tool'], r['summary']])).toEqual([
      ['update_habit', 'Archived the habit Run'],
      ['update_habit', 'Changed the habit Floss nightly'],
      ['update_habit', 'Renamed the habit Floss nightly to Run'],
      ['update_habit', 'Renamed the habit Floss to Floss nightly'],
      ['update_habit', 'Unarchived the habit Run'],
    ]);
  });

  it('logs today and yesterday done, skipped or cleared, in the app’s shape', async () => {
    await habitsOn();
    await appHabit('floss', 'Floss');
    const t = tools();
    const done = await t.logHabit({ habit: 'Floss', state: 'done' });
    expect(done).toMatchObject({
      id: 'floss',
      date: '2026-11-21',
      state: 'done',
      changed: true,
      today: { date: '2026-11-21', state: 'done' },
      streak: { count: 1, unit: 'days' },
    });
    expect(await log('floss_2026-11')).toEqual({
      habit: 'floss',
      month: '2026-11',
      days: { '21': { state: 'done', at: at(T) } },
      updatedAt: at(T),
    });
    await t.logHabit({ habit: 'floss', state: 'skipped', date: '2026-11-20' });
    const skipped = await t.logHabit({ habit: 'floss', state: 'done', date: '2026-11-20' });
    expect(skipped).toMatchObject({
      yesterday: { date: '2026-11-20', state: 'done' },
      streak: { count: 2 },
    });
    // The same again changes nothing and records nothing.
    expect(await t.logHabit({ habit: 'floss', state: 'done' })).toMatchObject({ changed: false });
    const cleared = await t.logHabit({ habit: 'floss', state: 'none' });
    expect(cleared).toMatchObject({ changed: true, today: { state: 'none' } });
    expect((await log('floss_2026-11'))?.['days']).toEqual({
      '20': { state: 'done', at: at(T) },
    });
    expect((await runs()).map((r) => r['summary'])).toEqual([
      'Logged Floss: cleared today',
      'Logged Floss: done today',
      'Logged Floss: done yesterday',
      'Logged Floss: skipped yesterday',
    ]);
  });

  it('refuses a day outside today and yesterday, and an archived habit', async () => {
    await habitsOn();
    await appHabit('floss', 'Floss');
    const t = tools();
    for (const date of ['2026-11-19', '2026-11-22'])
      await expect(t.logHabit({ habit: 'floss', state: 'done', date })).rejects.toThrow(
        /today \(2026-11-21\) or yesterday \(2026-11-20\) only, in its own time zone/,
      );
    await expect(t.logHabit({ habit: 'floss', state: 'done', date: 'Nov 21' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    // Today is the habit's own: in Tokyo it is already Sunday.
    await appHabit('tea', 'Tea', { tz: 'Asia/Tokyo' });
    expect(await t.logHabit({ habit: 'tea', state: 'done' })).toMatchObject({
      date: '2026-11-22',
    });
    await appHabit('run', 'Run', { archived: true });
    await expect(t.logHabit({ habit: 'run', state: 'done' })).rejects.toThrow(
      /Run is archived; unarchive it with update_habit/,
    );
    expect(await log('run_2026-11')).toBeUndefined();
  });

  it('refuses a day before the habit began, and a yesterday in the same week (review of #329)', async () => {
    await habitsOn();
    // Made today, the 21st in Los Angeles: the 20th is before it.
    await appHabit('new', 'New', { createdAt: at(T - 3600_000) });
    const t = tools();
    await expect(t.logHabit({ habit: 'new', state: 'done', date: '2026-11-20' })).rejects.toThrow(
      /New began on 2026-11-21; 2026-11-20 is before it/,
    );
    expect(await t.logHabit({ habit: 'new', state: 'done' })).toMatchObject({
      date: '2026-11-21',
    });
    // Made on the 1st: on the 2nd, the 1st can be logged, not October 31st.
    await appHabit('first', 'First', { createdAt: at(Date.parse('2026-11-01T17:00:00Z')) });
    const second = tools(Date.parse('2026-11-02T19:00:00Z'));
    expect(
      await second.logHabit({ habit: 'first', state: 'done', date: '2026-11-01' }),
    ).toMatchObject({ date: '2026-11-01', changed: true });
    const first = tools(Date.parse('2026-11-01T19:00:00Z'));
    await expect(
      first.logHabit({ habit: 'first', state: 'done', date: '2026-10-31' }),
    ).rejects.toThrow(/began on 2026-11-01/);
    expect(await log('first_2026-10')).toBeUndefined();
    // A weekly habit on Saturday: Friday is the same week; on a Monday,
    // Sunday ended the week before and can still be logged.
    await appHabit('moss', 'Water the moss', { schedule: 'weekly' });
    await expect(t.logHabit({ habit: 'moss', state: 'done', date: '2026-11-20' })).rejects.toThrow(
      /yesterday \(2026-11-20\) is in the same week as today/,
    );
    const monday = tools(Date.parse('2026-11-23T19:00:00Z'));
    expect(
      await monday.logHabit({ habit: 'moss', state: 'done', date: '2026-11-22' }),
    ).toMatchObject({ date: '2026-11-22', changed: true });
  });

  it('merges a tick from the app and one from the tool into one month log', async () => {
    await habitsOn();
    await appHabit('floss', 'Floss');
    await appTick('floss', '2026-11-20', 'done');
    await tools().logHabit({ habit: 'floss', state: 'skipped' });
    expect(await log('floss_2026-11')).toEqual({
      habit: 'floss',
      month: '2026-11',
      days: {
        '20': { state: 'done', at: at(T - 3600_000) },
        '21': { state: 'skipped', at: at(T) },
      },
      updatedAt: at(T),
    });
  });

  it('logs a habit of another kind done or skipped without an answer, and says so', async () => {
    await habitsOn();
    await appHabit('journal', 'Journal', { answer: 'note', template: 'tpl-journal' });
    // The app's check-in made a note; skipping it drops the note id, as the app does.
    await appTick('journal', '2026-11-21', 'done', { noteId: 'n1' });
    const t = tools();
    expect(await t.logHabit({ habit: 'Journal', state: 'skipped' })).not.toHaveProperty('note');
    expect((await log('journal_2026-11'))?.['days']).toEqual({
      '21': { state: 'skipped', at: at(T) },
    });
    const done = await t.logHabit({ habit: 'Journal', state: 'done', date: '2026-11-20' });
    expect(done.note).toMatch(/asks for a note in the app; it is logged done without one/);
    expect((await log('journal_2026-11'))?.['days']).toMatchObject({
      '20': { state: 'done', at: at(T) },
    });
    expect(JSON.stringify(await log('journal_2026-11'))).not.toContain('answer');
  });

  it('gives get_context today’s habits, due, done or skipped, while Habits is on', async () => {
    await habitsOn();
    await appHabit('floss', 'Floss', { time: '21:00' });
    await appHabit('pills', 'Metamucil', { time: '11:00' });
    await appHabit('moss', 'Water the moss', { schedule: 'weekly' });
    await appHabit('old', 'Old habit', { archived: true });
    await appTick('pills', '2026-11-21', 'done');
    // Settled on Thursday: not due again this week.
    await appTick('moss', '2026-11-19', 'skipped');
    const t = tools();
    expect((await t.getContext({ habits: true })).habits).toEqual([
      { id: 'pills', name: 'Metamucil', time: '11:00', state: 'done' },
      { id: 'floss', name: 'Floss', time: '21:00', state: 'due' },
    ]);
    // The instructions read on connecting carry no habits.
    expect(await t.getContext()).not.toHaveProperty('habits');
  });
});
