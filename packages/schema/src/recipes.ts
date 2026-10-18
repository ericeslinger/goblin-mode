// Recipes (#127, Eric 2026-10-18; epic #125): a note of kind `recipe`
// whose sections hold its ingredients, method and notes. The text is the
// source of truth, written and edited like any note; these helpers read
// its structure, the way the shopping list reads its checkboxes.

/** A recipe's sections, in order. */
export const RECIPE_SECTIONS = ['Ingredients', 'Method', 'Notes'] as const;

/** The text a new recipe starts with: its sections, empty. */
export function recipeSkeleton(): string {
  return RECIPE_SECTIONS.map((s) => `## ${s}\n`).join('\n');
}

/** Units the parser knows, each spelling to the one it stands for. */
const UNITS: Record<string, string> = Object.fromEntries(
  (
    [
      ['cup', 'cup', 'cups', 'c'],
      ['tbsp', 'tbsp', 'tbsps', 'tablespoon', 'tablespoons', 'tbs', 'T'],
      ['tsp', 'tsp', 'tsps', 'teaspoon', 'teaspoons', 't'],
      ['g', 'g', 'gram', 'grams', 'gr'],
      ['kg', 'kg', 'kilogram', 'kilograms'],
      ['ml', 'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'],
      ['l', 'l', 'liter', 'liters', 'litre', 'litres'],
      ['oz', 'oz', 'ounce', 'ounces'],
      ['lb', 'lb', 'lbs', 'pound', 'pounds'],
      ['clove', 'clove', 'cloves'],
      ['can', 'can', 'cans', 'tin', 'tins'],
      ['pinch', 'pinch', 'pinches'],
      ['handful', 'handful', 'handfuls'],
      ['bunch', 'bunch', 'bunches'],
      ['slice', 'slice', 'slices'],
      ['sprig', 'sprig', 'sprigs'],
      ['stick', 'stick', 'sticks'],
      ['piece', 'piece', 'pieces'],
    ] as const
  ).flatMap(([unit, ...spellings]) => spellings.map((s) => [s, unit])),
);

/**
 * The unit a word spells, any case ("Tbsp", "CUPS"), except the one
 * letters, where case is the difference: T is a tablespoon, t a teaspoon.
 */
function unitOf(word: string): string | undefined {
  if (Object.hasOwn(UNITS, word)) return UNITS[word];
  const lower = word.toLowerCase();
  return lower.length > 1 && Object.hasOwn(UNITS, lower) ? UNITS[lower] : undefined;
}

const FRACTIONS: Record<string, number> = {
  '¼': 0.25,
  '½': 0.5,
  '¾': 0.75,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅛': 0.125,
};

/** One ingredient line, read. `text` is the line as written, after its bullet. */
export interface Ingredient {
  /** Which line of the body (0-based). */
  line: number;
  text: string;
  /** The amount as written ("1 1/2", "2-3"), if any. */
  quantity?: string;
  /** The amount as a number (a range's low end), if it reads as one. */
  amount?: number;
  unit?: string;
  /** What to buy: the words after the amount and unit, before a comma. */
  item: string;
  /** What follows the first comma ("finely chopped"). */
  note?: string;
  /** The `###` sub-heading it sits under ("For the sauce"). */
  group?: string;
}

const NUMBER = String.raw`(?:\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+|\d*[¼½¾⅓⅔⅛])`;
const QUANTITY = new RegExp(String.raw`^(${NUMBER}(?:\s*(?:-|–|to)\s*${NUMBER})?)\s*`);

/** A number from one written amount: "1 1/2" 1.5, "½" 0.5, "2,5" 2.5. */
function toNumber(written: string): number | undefined {
  let total = 0;
  for (const part of written.trim().split(/\s+/)) {
    const frac = /^(\d*)([¼½¾⅓⅔⅛])$/.exec(part);
    if (frac) total += Number(frac[1] || 0) + FRACTIONS[frac[2]];
    else if (/^\d+\/\d+$/.test(part)) {
      const [n, d] = part.split('/').map(Number);
      if (!d) return undefined;
      total += n / d;
    } else if (/^\d+(?:[.,]\d+)?$/.test(part)) total += Number(part.replace(',', '.'));
    else return undefined;
  }
  return total;
}

/** Reads one ingredient line (its bullet already off). */
export function parseIngredient(text: string, line = 0, group?: string): Ingredient {
  let rest = text.trim();
  const out: Ingredient = { line, text, item: '' };
  if (group) out.group = group;
  const q = QUANTITY.exec(rest);
  if (q) {
    out.quantity = q[1];
    const low = q[1].split(/\s*(?:-|–|to)\s*/)[0];
    const amount = toNumber(low);
    if (amount !== undefined) out.amount = amount;
    rest = rest.slice(q[0].length);
  } else {
    // "a handful of parsley", "an onion": an article, not an amount.
    rest = rest.replace(/^an?\s+/i, '');
  }
  const word = /^([A-Za-z]+)\.?(?:\s+of)?\s+/.exec(rest);
  const unit = word && unitOf(word[1]);
  if (word && unit && (q || word[1].length > 1)) {
    out.unit = unit;
    rest = rest.slice(word[0].length);
  }
  const comma = rest.indexOf(',');
  out.item = (comma === -1 ? rest : rest.slice(0, comma)).trim();
  if (comma !== -1 && rest.slice(comma + 1).trim()) out.note = rest.slice(comma + 1).trim();
  return out;
}

const BULLET = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*\S)\s*$/;

/** The lines under `## <name>`, each with its index, to the next `##`. */
function section(body: string, name: string): { line: number; text: string }[] {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(l));
  if (start === -1) return [];
  const out: { line: number; text: string }[] = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    out.push({ line: i, text: lines[i] });
  }
  return out;
}

/** The recipe's ingredients, in order, each with its `###` group if any. */
export function ingredients(body: string): Ingredient[] {
  let group: string | undefined;
  const out: Ingredient[] = [];
  for (const { line, text } of section(body, 'Ingredients')) {
    const heading = /^###\s+(.*\S)\s*$/.exec(text);
    if (heading) {
      group = heading[1];
      continue;
    }
    const bullet = BULLET.exec(text);
    if (bullet) out.push(parseIngredient(bullet[1], line, group));
  }
  return out;
}

/** The method's steps, in order: its numbered (or bulleted) lines. */
export function methodSteps(body: string): string[] {
  return section(body, 'Method')
    .map(({ text }) => NUMBERED.exec(text)?.[1] ?? BULLET.exec(text)?.[1])
    .filter((s): s is string => !!s);
}

/** A recipe's body from its parts, as create_recipe writes it. */
export function recipeBody(parts: {
  ingredients: readonly string[];
  method: readonly string[];
  notes?: string;
}): string {
  const lines = (xs: readonly string[], mark: (n: number) => string) => {
    // Numbered by step: a `###` group heading is not one (review on #135).
    let n = 0;
    return xs
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) =>
        /^###\s/.test(x) ? x : `${mark(++n)} ${x.replace(/^[-*+]\s+|^\d+[.)]\s+/, '')}`,
      );
  };
  return [
    '## Ingredients',
    '',
    ...lines(parts.ingredients, () => '-'),
    '',
    '## Method',
    '',
    ...lines(parts.method, (n) => `${n}.`),
    '',
    '## Notes',
    '',
    ...(parts.notes?.trim() ? [parts.notes.trim(), ''] : []),
  ].join('\n');
}

/** Whether a recipe's text is still the skeleton it started with. */
export function untouchedRecipe(body: string): boolean {
  return body.replace(/\s+/g, ' ').trim() === recipeSkeleton().replace(/\s+/g, ' ').trim();
}

/** A link's site, without its www. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The name a recipe imported from `url` carries until its page is read
 * (#128): "Recipe from example.com", then "(2)", "(3)" when one is taken.
 */
export function importPlaceholder(url: string, n = 1): string {
  const base = `Recipe from ${hostOf(url) || 'a link'}`;
  return n > 1 ? `${base} (${n})` : base;
}

/** Whether a recipe still carries the name it was imported under. */
export function isImportPlaceholder(title: string, url: string): boolean {
  const base = importPlaceholder(url);
  return title === base || (title.startsWith(base) && /^ \(\d+\)$/.test(title.slice(base.length)));
}
