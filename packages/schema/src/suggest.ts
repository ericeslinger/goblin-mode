// Recipe suggestions (#132, epic #125): recipes not made lately, ranked
// by how much of what each needs is on hand (#131). Read from the
// recipes' text, the meal plans' made history (#129) and the pantry,
// nothing stored.
import { normalizeName } from './concepts';
import { itemKey } from './grocery';
import { addDays } from './mealplan';
import { ingredients } from './recipes';

/** Made within this many days: not suggested again yet. */
export const RECENT_DAYS = 7;

export interface Suggestion {
  id: string;
  title: string;
  /** Its ingredients on hand, and all of them. */
  onHand: number;
  total: number;
  /** What would need buying, as the recipe names it. */
  missing: string[];
  /** When it was last made, YYYY-MM-DD, if ever. */
  lastMade?: string;
}

/**
 * The recipes to suggest for `today`: not made in the last week, most
 * of what they need on hand first, then the longest since made (never
 * made first), then by name. A recipe with no ingredients written yet
 * is not suggested, having nothing to go on.
 */
export function suggestRecipes(
  recipes: readonly { id: string; title: string; body: string }[],
  made: ReadonlyMap<string, readonly string[]>,
  have: ReadonlySet<string>,
  today: string,
  limit = 5,
): Suggestion[] {
  const recent = addDays(today, -RECENT_DAYS);
  const out: (Suggestion & { share: number })[] = [];
  for (const r of recipes) {
    const items = ingredients(r.body);
    if (!items.length) continue;
    const dates = made.get(normalizeName(r.title)) ?? [];
    const lastMade = dates[dates.length - 1];
    if (lastMade && lastMade > recent) continue;
    const missing = items.filter((i) => !have.has(itemKey(i.item || i.text)));
    const onHand = items.length - missing.length;
    out.push({
      id: r.id,
      title: r.title,
      onHand,
      total: items.length,
      missing: missing.map((i) => i.item || i.text),
      ...(lastMade ? { lastMade } : {}),
      share: onHand / items.length,
    });
  }
  out.sort(
    (a, b) =>
      b.share - a.share ||
      (a.lastMade ?? '').localeCompare(b.lastMade ?? '') ||
      a.title.localeCompare(b.title),
  );
  return out.slice(0, limit).map(({ share: _, ...s }) => s);
}
