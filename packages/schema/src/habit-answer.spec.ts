import { describe, expect, it } from 'vitest';
import {
  HABIT_CHOICE_PADDED,
  HABIT_TEXT_PADS,
  habitAnswerLine,
  habitChoicesProblem,
  openHabitAnswer,
  padHabitAnswer,
  sealHabitAnswer,
  unpadHabitAnswer,
} from './habit-answer';
import { HABIT_ANSWER_STORED_MAX, HABIT_TEXT_MAX, HabitEntry } from './model';
import { SealError, isSealed, newDataKey } from './sealed';

// A check-in's answer (#324 step 6, 2026-11-22): cleaned to one line,
// padded, sealed under the day's own aad, and opened again.

const key = newDataKey();
const at = { seconds: 0, nanoseconds: 0 };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof SealError) return e.code;
    throw e;
  }
  return undefined;
}

describe('habit answers (#324 step 6)', () => {
  it('round-trips a choice and a line of text, emoji and all', () => {
    for (const [kind, text] of [
      ['choice', 'calm'],
      ['choice', '🙂 fine'],
      ['text', 'Walked to the river and back'],
      ['text', ''],
    ] as const) {
      const sealed = sealHabitAnswer(key, 'u1', 'mood', '2026-11-22', kind, text);
      expect(isSealed(sealed)).toBe(true);
      if (text.length > 3) expect(sealed).not.toContain(text);
      expect(openHabitAnswer(key, 'u1', 'mood', '2026-11-22', sealed)).toBe(text);
    }
  });

  it('seals every choice of a list to the same length, whatever its own', () => {
    const choices = ['ok', 'anxious', 'a little tired but fine', '😀'.repeat(20)];
    const lengths = new Set(
      choices.map((c) => sealHabitAnswer(key, 'u1', 'mood', '2026-11-22', 'choice', c).length),
    );
    expect(lengths.size).toBe(1);
    // The longest a choice can be in bytes still fits the padded size.
    expect(new TextEncoder().encode('😀'.repeat(20)).length).toBeLessThanOrEqual(
      HABIT_CHOICE_PADDED,
    );
    expect(new TextEncoder().encode(padHabitAnswer('choice', 'ok')).length).toBe(
      HABIT_CHOICE_PADDED,
    );
  });

  it('pads a text up to the first of its three sizes that holds it', () => {
    const size = (t: string) => new TextEncoder().encode(padHabitAnswer('text', t)).length;
    expect(size('yes')).toBe(HABIT_TEXT_PADS[0]);
    expect(size('no')).toBe(HABIT_TEXT_PADS[0]);
    expect(size('x'.repeat(129))).toBe(HABIT_TEXT_PADS[1]);
    expect(size('x'.repeat(513))).toBe(HABIT_TEXT_PADS[2]);
    expect(unpadHabitAnswer(padHabitAnswer('text', 'yes'))).toBe('yes');
  });

  it('fits the longest text, sealed and padded, in the 4,000 an entry stores', () => {
    // 500 units of three-byte characters: the most bytes a text can be.
    const longest = '語'.repeat(HABIT_TEXT_MAX);
    const sealed = sealHabitAnswer(key, 'u1', 'h', '2026-11-22', 'text', longest);
    expect(sealed.length).toBeLessThanOrEqual(HABIT_ANSWER_STORED_MAX);
    expect(HabitEntry.safeParse({ state: 'done', at, answer: sealed }).success).toBe(true);
    expect(openHabitAnswer(key, 'u1', 'h', '2026-11-22', sealed)).toBe(longest);
  });

  it('opens only as the same user, habit and day, and never plain text', () => {
    const sealed = sealHabitAnswer(key, 'u1', 'mood', '2026-11-22', 'choice', 'calm');
    expect(code(() => openHabitAnswer(key, 'u2', 'mood', '2026-11-22', sealed))).toBe('failed');
    expect(code(() => openHabitAnswer(key, 'u1', 'walk', '2026-11-22', sealed))).toBe('failed');
    expect(code(() => openHabitAnswer(key, 'u1', 'mood', '2026-11-21', sealed))).toBe('failed');
    expect(code(() => openHabitAnswer(key, 'u1', 'mood', '2026-10-22', sealed))).toBe('failed');
    expect(code(() => openHabitAnswer(newDataKey(), 'u1', 'mood', '2026-11-22', sealed))).toBe(
      'failed',
    );
    expect(code(() => openHabitAnswer(key, 'u1', 'mood', '2026-11-22', 'calm'))).toBe('not-sealed');
  });

  it('cleans an answer to one line, cut without splitting a pair', () => {
    expect(habitAnswerLine('  two\nlines\t here\u0000 ')).toBe('two lines here');
    expect(habitAnswerLine('abc', 2)).toBe('ab');
    expect(habitAnswerLine('a😀', 2)).toBe('a');
    expect(habitAnswerLine('x'.repeat(600)).length).toBe(HABIT_TEXT_MAX);
    expect(habitAnswerLine('\uE000mg1.abc')).toBe('mg1.abc');
  });

  it('says what is wrong with a list of choices', () => {
    expect(habitChoicesProblem(['calm', 'tired'])).toBeUndefined();
    expect(habitChoicesProblem(['calm'])).toMatch(/2 to 12/);
    expect(habitChoicesProblem(Array.from({ length: 13 }, (_, i) => `c${i}`))).toMatch(/2 to 12/);
    expect(habitChoicesProblem(['calm', ''])).toMatch(/1 to 40/);
    expect(habitChoicesProblem(['calm', 'x'.repeat(41)])).toMatch(/1 to 40/);
    expect(habitChoicesProblem(['Calm', 'calm '])).toMatch(/twice/);
  });
});
