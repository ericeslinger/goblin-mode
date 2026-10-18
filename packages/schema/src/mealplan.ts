// The meal plan (#129, Eric 2026-10-18; epic #125, Kitchen module): one
// note of kind `mealplan` per week, its id derived from the week's first
// day so a phone offline makes the same note Claude would. One line per
// meal slot, a box that means made:
//
//   - [ ] Mon dinner: [[Shakshuka]] (half recipe)
//   - [ ] Tue dinner: delivery, Thai
//     - the dandan noodles were really good
//
// The text is the source of truth; these helpers read and write its
// lines, the way the shopping list reads its checkboxes.
import { z } from 'zod';
import { normalizeName } from './concepts';

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const MEALS = ['breakfast', 'lunch', 'dinner'] as const;
export type Meal = (typeof MEALS)[number];

/**
 * Kitchen's configuration, in `settings/modules` (kitchen.config), with
 * today's ask as the default: a week from Monday, dinners only, and the
 * weekly fish on Thursday. The period is always a week for now.
 */
export const KitchenConfig = z.object({
  weekStart: z.enum(WEEKDAYS).catch('Mon').default('Mon'),
  meals: z.array(z.enum(MEALS)).min(1).catch(['dinner']).default(['dinner']),
  /** Which dinner starts as "Fish of the week" in a new plan, or none. */
  fishDay: z.enum(['Thu', 'Fri', 'none']).catch('Thu').default('Thu'),
});
export type KitchenConfig = z.infer<typeof KitchenConfig>;

/** Kitchen's configuration from whatever is stored, defaults filling gaps. */
export function kitchenConfig(raw: unknown): KitchenConfig {
  const parsed = KitchenConfig.safeParse(raw && typeof raw === 'object' ? raw : {});
  return parsed.success ? parsed.data : KitchenConfig.parse({});
}

/** The placeholder recipe a new plan's fish dinner links to, and its id. */
export const FISH_NAME = 'Fish of the week';
export const FISH_ID = 'recipe-fish-of-the-week';
/** The placeholder's text: what it is for, in its Notes. */
export const FISH_BODY =
  '## Ingredients\n\n## Method\n\n## Notes\n\n' +
  'The weekly fish. When you know what it is, put its recipe on the plan in place of this.\n';

/** A plan's id, from its first day: meals-2026-10-19. */
export function planId(start: string): string {
  return `meals-${start}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a string is a calendar date, YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  if (!ISO.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** A local date as YYYY-MM-DD (the device's own calendar day). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `iso` moved by `days`, as a calendar date (no time zone in it). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The weekday of a calendar date. */
export function weekdayOf(iso: string): Weekday {
  // getUTCDay: Sunday 0; WEEKDAYS starts on Monday.
  return WEEKDAYS[(new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7];
}

/** The first day of the week holding `iso`, weeks starting on `weekStart`. */
export function periodStartFor(iso: string, weekStart: Weekday = 'Mon'): string {
  const back = (WEEKDAYS.indexOf(weekdayOf(iso)) - WEEKDAYS.indexOf(weekStart) + 7) % 7;
  return addDays(iso, -back);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 19", for a calendar date. */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** A plan's name: "Meals, week of Oct 19". */
export function planTitle(start: string): string {
  return `Meals, week of ${shortDate(start)}`;
}

/** A new plan's text: a line per day and meal, the fish on its day. */
export function planBody(start: string, config: KitchenConfig): string {
  const lines = [`## Week of ${shortDate(start)}`, ''];
  for (let i = 0; i < 7; i++) {
    const day = weekdayOf(addDays(start, i));
    for (const meal of MEALS) {
      if (!config.meals.includes(meal)) continue;
      const fish = meal === 'dinner' && day === config.fishDay;
      lines.push(`- [ ] ${day} ${meal}:${fish ? ` [[${FISH_NAME}]]` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** One meal slot on a plan, as read from its line. */
export interface Slot {
  /** Which line of the body (0-based). */
  line: number;
  day: Weekday;
  /** Its calendar date. */
  date: string;
  meal: Meal;
  /** Its box is ticked: the meal was made (or eaten). */
  made: boolean;
  /** What follows the colon, as written. */
  text: string;
  kind: 'recipe' | 'delivery' | 'out' | 'empty' | 'other';
  /** The recipe a `[[link]]` names. */
  recipe?: string;
  /** A ratio called out on the line ("half recipe" 0.5, "x2" 2). */
  ratio?: number;
  /** The lines under it, indented: how it went, what the delivery was. */
  notes: string[];
}

const SLOT = new RegExp(
  String.raw`^\s*[-*+]\s+\[([ xX])\]\s+(${WEEKDAYS.join('|')})\s+(${MEALS.join('|')})\s*:\s*(.*?)\s*$`,
  'i',
);
const NOTE_LINE = /^\s{2,}[-*+]\s+(.*\S)\s*$/;
const WORD_RATIOS: Record<string, number> = { quarter: 0.25, half: 0.5, double: 2, triple: 3 };

/** A ratio called out on a slot's line, if any. */
export function ratioOf(text: string): number | undefined {
  const word = /\b(quarter|half|double|triple)\b/i.exec(text)?.[1];
  if (word) return WORD_RATIOS[word.toLowerCase()];
  const times = /(?:^|\s|\()(?:x\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*x)(?=$|\s|\))/i.exec(text);
  const n = Number(times?.[1] ?? times?.[2]);
  if (times && n > 0) return n;
  const frac = /\b(\d+)\/(\d+)\s+recipe\b/i.exec(text);
  if (frac && Number(frac[2]) > 0) return Number(frac[1]) / Number(frac[2]);
  return undefined;
}

const canonical = <T extends string>(all: readonly T[], word: string): T =>
  all.find((x) => x.toLowerCase() === word.toLowerCase())!;

/** A plan's slots, in order, each with its date from the plan's start. */
export function planSlots(body: string, start: string): Slot[] {
  const lines = body.split('\n');
  const out: Slot[] = [];
  const days = new Map(
    Array.from({ length: 7 }, (_, i) => [weekdayOf(addDays(start, i)), addDays(start, i)]),
  );
  for (let i = 0; i < lines.length; i++) {
    const m = SLOT.exec(lines[i]);
    if (m) {
      const day = canonical(WEEKDAYS, m[2]);
      const text = m[4];
      const link = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(text);
      const kind = !text
        ? 'empty'
        : link
          ? 'recipe'
          : /^deliver(y|ed)\b/i.test(text)
            ? 'delivery'
            : /^out\b/i.test(text)
              ? 'out'
              : 'other';
      const slot: Slot = {
        line: i,
        day,
        date: days.get(day)!,
        meal: canonical(MEALS, m[3]),
        made: m[1] !== ' ',
        text,
        kind,
        notes: [],
      };
      if (link) slot.recipe = link[1].trim();
      const ratio = ratioOf(link ? text.slice(link[0].length) : text);
      if (ratio !== undefined && kind !== 'empty') slot.ratio = ratio;
      out.push(slot);
      continue;
    }
    const note = NOTE_LINE.exec(lines[i]);
    const last = out[out.length - 1];
    if (note && last && last.line + 1 + last.notes.length === i) last.notes.push(note[1]);
  }
  return out;
}

const sameSlot = (s: Slot, day: Weekday, meal: Meal) => s.day === day && s.meal === meal;

/**
 * The plan with one slot's text replaced. A change unticks it (a new
 * dinner is not made yet); its notes stay, being someone's words. A
 * slot the plan lacks is added at the end.
 */
export function setSlot(
  body: string,
  start: string,
  day: Weekday,
  meal: Meal,
  text: string,
): string {
  const value = text.trim();
  const slot = planSlots(body, start).find((s) => sameSlot(s, day, meal));
  const line = (made: boolean) =>
    `- [${made ? 'x' : ' '}] ${day} ${meal}:${value ? ` ${value}` : ''}`;
  const lines = body.split('\n');
  if (!slot) {
    const end = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(end, 0, line(false));
    return lines.join('\n');
  }
  lines[slot.line] = line(slot.made && slot.text === value);
  return lines.join('\n');
}

/** The plan with one slot ticked made, or unticked. */
export function setMade(
  body: string,
  start: string,
  day: Weekday,
  meal: Meal,
  made: boolean,
): string {
  const slot = planSlots(body, start).find((s) => sameSlot(s, day, meal));
  if (!slot) return body;
  const lines = body.split('\n');
  lines[slot.line] = lines[slot.line].replace(/\[[ xX]\]/, made ? '[x]' : '[ ]');
  return lines.join('\n');
}

/** The plan with a note under a slot: how it went, what the delivery was. */
export function addSlotNote(
  body: string,
  start: string,
  day: Weekday,
  meal: Meal,
  text: string,
): string {
  const slot = planSlots(body, start).find((s) => sameSlot(s, day, meal));
  const note = text.trim().replace(/\s*\n\s*/g, ' ');
  if (!slot || !note) return body;
  const lines = body.split('\n');
  lines.splice(slot.line + 1 + slot.notes.length, 0, `  - ${note}`);
  return lines.join('\n');
}

/**
 * When each recipe was made, from every plan's ticked slots: recipe name
 * (normalized) to its dates, oldest first.
 */
export function madeHistory(
  plans: readonly { body: string; periodStart?: string }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const plan of plans) {
    if (!plan.periodStart || !isIsoDate(plan.periodStart)) continue;
    for (const s of planSlots(plan.body, plan.periodStart)) {
      if (!s.made || !s.recipe) continue;
      const key = normalizeName(s.recipe);
      out.set(key, [...(out.get(key) ?? []), s.date]);
    }
  }
  for (const dates of out.values()) dates.sort();
  return out;
}

/** "Made 4 times, last Oct 2", or nothing for a recipe never made. */
export function madeLine(dates: readonly string[] | undefined): string {
  if (!dates?.length) return '';
  const times = dates.length === 1 ? 'once' : `${dates.length} times`;
  return `Made ${times}, last ${shortDate(dates[dates.length - 1])}`;
}
