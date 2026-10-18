// Importing a recipe from a link (#128, epic #125): the page is fetched
// by a function, as a saved link is (#48), and read for its recipe. Most
// recipe sites publish one as schema.org JSON-LD for search engines;
// that is read first, for free. A page without one is read by a small
// Claude model, when this deployment has one. Over small interfaces, so
// it runs in specs.
import { type PageFetcher, pageText } from '../attachments/import';

/** A recipe as read from a page, its words as the page has them. */
export interface ImportedRecipe {
  name: string;
  /** Ingredient lines; a `### ` line is a group heading. */
  ingredients: string[];
  /** Method steps; a `### ` line is a section heading. */
  method: string[];
  servings?: number;
}

/** Reads a recipe out of a page's text, or says there is none. */
export type RecipeExtractor = (page: {
  url: string;
  title: string;
  text: string;
}) => Promise<ImportedRecipe | undefined>;

const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** JSON-LD strings often carry HTML: tags out, entities decoded, one line. */
function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]+>/g, '')
    .replace(ENTITY, (whole, code: string) => {
      if (code[0] !== '#') return NAMED[code.toLowerCase()] ?? whole;
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function isRecipe(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== 'object') return false;
  const type = (node as Record<string, unknown>)['@type'];
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
}

/** Every object in a JSON-LD value: arrays, @graph and nesting walked. */
function* nodes(value: unknown, depth = 0): Generator<unknown> {
  if (depth > 6 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) yield* nodes(v, depth + 1);
    return;
  }
  yield value;
  const graph = (value as Record<string, unknown>)['@graph'];
  if (graph) yield* nodes(graph, depth + 1);
  const main = (value as Record<string, unknown>)['mainEntity'];
  if (main) yield* nodes(main, depth + 1);
}

/** recipeInstructions: a string, steps, or sections of steps. */
function steps(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === 'string') {
    return value
      .split(/\n+|<br\s*\/?>|<\/p>|<\/li>/i)
      .map(clean)
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap((v) => steps(v, depth + 1));
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  const inner = node['itemListElement'];
  if (inner !== undefined) {
    const heading = clean(node['name']);
    const body = steps(inner, depth + 1);
    return heading && body.length ? [`### ${heading}`, ...body] : body;
  }
  const text = clean(node['text']) || clean(node['name']);
  return text ? [text] : [];
}

/** recipeYield: "4", "Serves 4", ["4", "4 servings"], 4. */
function servingsOf(value: unknown): number | undefined {
  const first = Array.isArray(value) ? value.find((v) => servingsOf(v) !== undefined) : value;
  if (typeof first === 'number') return first > 0 ? Math.round(first) : undefined;
  const n = /\d+/.exec(typeof first === 'string' ? first : '')?.[0];
  return n && Number(n) > 0 ? Number(n) : undefined;
}

/** The first schema.org Recipe in a page's JSON-LD, if it has one. */
export function recipeFromJsonLd(html: string): ImportedRecipe | undefined {
  const scripts = html.matchAll(
    /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const [, json] of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(json.trim());
    } catch {
      continue;
    }
    for (const node of nodes(data)) {
      if (!isRecipe(node)) continue;
      const raw = node['recipeIngredient'] ?? node['ingredients'];
      const ingredients = (Array.isArray(raw) ? raw : [raw]).map(clean).filter(Boolean);
      const method = steps(node['recipeInstructions']);
      const name = clean(node['name']);
      if (!name || (!ingredients.length && !method.length)) continue;
      const servings = servingsOf(node['recipeYield']);
      return { name, ingredients, method, ...(servings ? { servings } : {}) };
    }
  }
  return undefined;
}

/** The most page text the fallback model is sent. */
export const MAX_RECIPE_PAGE_CHARS = 40_000;

/**
 * Reads the recipe at `url`, or throws a reason to show Eric: the page
 * could not be fetched, is not a page, or holds no recipe to be found.
 */
export async function readRecipe(
  url: string,
  fetchPage: PageFetcher,
  extractor: RecipeExtractor | null,
): Promise<ImportedRecipe> {
  const page = await fetchPage(url);
  if (!/^text\/html|^application\/xhtml\+xml/i.test(page.contentType)) {
    throw new Error(`not a web page (${page.contentType || 'no type'})`);
  }
  const html = new TextDecoder().decode(page.bytes);
  const found = recipeFromJsonLd(html);
  if (found) return found;
  if (!extractor) throw new Error('no recipe found on the page');
  const { title, text } = pageText(html);
  const read = await extractor({ url, title, text: text.slice(0, MAX_RECIPE_PAGE_CHARS) });
  if (!read || !read.name.trim() || (!read.ingredients.length && !read.method.length)) {
    throw new Error('no recipe found on the page');
  }
  return read;
}
