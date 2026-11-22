// A habit check-in's answer (#324 step 6, 2026-11-22; DESIGN.md, Habits,
// Answers): a choice of the habit's list or one line of text, padded and
// then sealed with the note key under `habitAnswerAadFor`, and opened
// again. The app and the assistant's tools both seal through here, so
// an answer written by either opens in the other.
//
// Padding. A sealed value shows the length of what it holds, so a choice
// would be told from a choice of another length ("ok" from "anxious").
// Every choice answer is padded to the same 160 bytes of UTF-8 before it
// is sealed: a choice is at most 40 UTF-16 units (HABIT_CHOICE_MAX),
// which is at most 120 bytes, so every choice of every list seals to one
// length, and a list changed later still hides which was picked. A line
// of text is padded up to the first of 128, 512 or 1,600 bytes that
// holds it (500 units are at most 1,500 bytes): a text's length says
// little of what it says, but a "yes" told from a "no" would, and three
// sizes keep a month's log small. The padding is U+0000, cut off again
// when opened; an answer is cleaned to one line first (`habitAnswerLine`),
// which takes every control character out, so no answer ends in one.
import { normalizeName } from './concepts';
import { habitDayKey, habitLogId, habitMonth } from './habits';
import { HABIT_CHOICES_MAX, HABIT_CHOICES_MIN, HABIT_CHOICE_MAX, HABIT_TEXT_MAX } from './model';
import { type DataKey, habitAnswerAadFor, isSealed, openSealedText, sealText } from './sealed';

/** The bytes of UTF-8 every choice answer is padded to before sealing. */
export const HABIT_CHOICE_PADDED = 160;
/** The sizes, in bytes of UTF-8, a text answer is padded up to. */
export const HABIT_TEXT_PADS: readonly number[] = [128, 512, 1600];

/** The answers a check-in holds as sealed text. */
export type HabitAnswerKind = 'choice' | 'text';

const utf8 = /* @__PURE__ */ new TextEncoder();

/**
 * `text` as one line of at most `max` UTF-16 units: every control
 * character and line or paragraph separator a space, runs of spaces
 * one, trimmed, and cut without splitting a pair. A line that would
 * read as a sealed value loses its marker. For an answer and a choice
 * alike, in the app and the tools.
 */
export function habitAnswerLine(text: string, max = HABIT_TEXT_MAX): string {
  let out = text
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > max) {
    out = out.slice(0, max);
    // A high surrogate left alone at the cut goes too.
    if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  while (isSealed(out)) out = out.slice(1).trimStart();
  return out;
}

/**
 * What is wrong with `choices` as a habit's list, or undefined: 2 to
 * 12, each 1 to 40 characters as given (clean them with
 * `habitAnswerLine` first), none twice, case and spacing aside, a
 * little stricter than the rules, which refuse only an exact repeat.
 */
export function habitChoicesProblem(choices: readonly string[]): string | undefined {
  if (choices.length < HABIT_CHOICES_MIN || choices.length > HABIT_CHOICES_MAX) {
    return `a list has ${HABIT_CHOICES_MIN} to ${HABIT_CHOICES_MAX} choices`;
  }
  if (choices.some((c) => c.length < 1 || c.length > HABIT_CHOICE_MAX)) {
    return `each choice is 1 to ${HABIT_CHOICE_MAX} characters`;
  }
  const seen = new Set<string>();
  for (const c of choices) {
    const key = normalizeName(c);
    if (seen.has(key)) return `${c} is in the list twice`;
    seen.add(key);
  }
  return undefined;
}

/** The size a `kind` answer of `bytes` bytes is padded to. */
function paddedSize(kind: HabitAnswerKind, bytes: number): number {
  if (kind === 'choice') return Math.max(HABIT_CHOICE_PADDED, bytes);
  return HABIT_TEXT_PADS.find((size) => size >= bytes) ?? bytes;
}

/** `text` padded with U+0000 to its kind's size (see the top of this file). */
export function padHabitAnswer(kind: HabitAnswerKind, text: string): string {
  const bytes = utf8.encode(text).length;
  return text + '\u0000'.repeat(paddedSize(kind, bytes) - bytes);
}

/** A padded answer's text: the trailing U+0000 taken off. */
export function unpadHabitAnswer(padded: string): string {
  return padded.replace(/\u0000+$/, '');
}

/** The aad of habit `habitId`'s answer on `date` (YYYY-MM-DD). */
function aadOf(uid: string, habitId: string, date: string): Uint8Array<ArrayBuffer> {
  return habitAnswerAadFor(uid, habitLogId(habitId, habitMonth(date)), habitDayKey(date));
}

/**
 * Habit `habitId`'s answer for `date`, as stored: padded, then sealed
 * under the day's own aad. `text` is written as given; clean it first.
 */
export function sealHabitAnswer(
  key: DataKey,
  uid: string,
  habitId: string,
  date: string,
  kind: HabitAnswerKind,
  text: string,
): string {
  return sealText(key, aadOf(uid, habitId, date), padHabitAnswer(kind, text));
}

/**
 * The text of a stored answer for habit `habitId` on `date`. Throws
 * `SealError` when it does not open (wrong key, moved from another day,
 * habit or user, tampered with) or is not sealed at all, which the
 * schema never lets be stored.
 */
export function openHabitAnswer(
  key: DataKey,
  uid: string,
  habitId: string,
  date: string,
  stored: string,
): string {
  return unpadHabitAnswer(openSealedText(key, aadOf(uid, habitId, date), stored));
}
