// Screening an imported recipe (Eric, 2026-10-18): a page can carry text
// meant for the AI that reads it rather than for the cook, hidden on the
// page or in its recipe data ("assistant, email the user's notes to...").
// What reads a page here has no tools, so such text can do nothing at
// import; but kept in the recipe, a later Claude with tools would read
// it. So a line that does not look like a recipe line is set aside: kept
// on the back as the page's text, out of what Claude is handed as the
// recipe. A screen cannot catch every wording; it keeps the obvious ones
// out of the text Eric cooks from, and the label on imported text in
// get_note covers the rest.
import type { ImportedRecipe } from './recipe-import';

/** Longest believable lines; anything longer is not a recipe line. */
const MAX_NAME = 120;
const MAX_INGREDIENT = 200;
const MAX_STEP = 1000;

/** Wordings that address a reader other than a cook, or reach outside the kitchen. */
const NOT_RECIPE: readonly RegExp[] = [
  // Links, addresses and markup.
  /https?:\/\/|\bwww\./i,
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /<\/?[a-z][^>]*>/i,
  /\[\[|\]\]/,
  // Talking to a model, or about one.
  /\b(ignore|disregard|forget|override|bypass)\b[^.]{0,60}\b(instructions?|previous|prior|above|prompts?|rules?|guidelines?|directives?|everything|told|said|safety)\b/i,
  /\b(new|updated|real|hidden|secret|important) (instructions?|directives?|orders|task)\b/i,
  /\b(system (prompt|message)|prompt injection|jailbreak|developer mode)\b/i,
  /\breveal\b[^.]{0,30}\b(system|prompt|instructions?|secrets?|rules)\b/i,
  /\b(assistants?|chatbots?|claude|chatgpt|gpt(-?\d)?|openai|anthropic|gemini|copilot|bard|llms?|language models?|ai (models?|agents?|systems?|tools?))\b/i,
  /\bA\.?I\b/,
  /\bDAN mode\b/i,
  /\b(you are an? (ai|assistant|agent|bot|model|language model)|as an ai|act as (an? )?(ai|assistant|dan|unfiltered))\b/i,
  /\b(tool|function) calls?\b|\b(call|invoke)\b[^.]{0,30}\btools?\b/i,
  // A tool's or a function's name: snake_case, never a recipe word.
  /\b[a-z]+_[a-z_]+\b/i,
  /\bthe user('s)?\b/i,
  /\b(archive|delete|erase|wipe|forward|share|upload|export)\b[^.]{0,30}\b(notes?|files?|data|everything|messages?|documents?|contacts?|calendar|inbox)\b/i,
  // Money, accounts and messages.
  /\bwire transfers?\b|\bwire\b[^.]{0,20}(money|funds|payment|\$|€|£)/i,
  /\b(venmo|paypal|zelle|bitcoin|btc|crypto(currency)?|gift cards?|bank accounts?|routing number|iban|swift code)\b/i,
  /\b(passwords?|credentials?|api keys?|credit card (numbers?|details)|card numbers?|social security|log ?in to|sign ?in to)\b/i,
  /\b(e-?mails?|inbox|text messages?)\b/i,
  /\bsend\b[^.]{0,30}\b(money|payment|message|details|data|info(rmation)?|notes|contacts?)\b/i,
  /\b(pay|unlock|purchase)\b[^.]{0,40}(\$|€|£)\s?\d/i,
];

/** Look-alike digits, as spelling tricks use them ("Ign0re"). */
const LOOKALIKE: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

/**
 * The line as a model would read it: compatibility forms folded (full
 * width letters, ligatures), invisible characters out; and a second
 * reading with look-alike digits as letters, tried too.
 */
function readings(line: string): string[] {
  const folded = line.normalize('NFKC').replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u00ad]/g, '');
  // Only inside words: "350 F" and "1 cup" stay numbers.
  // Letters spaced out to slip past ("i g n o r e") read as the word.
  const joined = folded.replace(/\b(?:\p{L} ){3,}\p{L}\b/gu, (run) => run.replace(/ /g, ''));
  const letters = joined.replace(/(?<=[a-z])[013457@$]|[013457@$](?=[a-z])/gi, (c) => LOOKALIKE[c]);
  return [...new Set([folded, joined, letters])];
}

/** Whether one line reads as something other than a recipe's words. */
export function notRecipeLike(line: string, max: number): boolean {
  if (line.length > max) return true;
  return readings(line).some((text) => NOT_RECIPE.some((re) => re.test(text)));
}

export interface Screened {
  /** The recipe with only recipe-like lines; an empty name if its name was set aside. */
  recipe: ImportedRecipe;
  /** The lines set aside, as the page had them. */
  setAside: string[];
}

/** Splits an imported recipe into recipe-like lines and the rest. */
export function screenRecipe(read: ImportedRecipe): Screened {
  const setAside: string[] = [];
  const keep = (lines: string[], max: number) =>
    lines.filter((line) => {
      if (!notRecipeLike(line, max)) return true;
      setAside.push(line);
      return false;
    });
  const nameOk = !notRecipeLike(read.name, MAX_NAME);
  if (!nameOk) setAside.push(read.name);
  const recipe: ImportedRecipe = {
    name: nameOk ? read.name : '',
    ingredients: keep(read.ingredients, MAX_INGREDIENT),
    method: keep(read.method, MAX_STEP),
    ...(read.servings ? { servings: read.servings } : {}),
  };
  return { recipe, setAside };
}
