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
  // Talking to a model.
  /\b(ignore|disregard|forget|override)\b[^.]{0,60}\b(instructions?|previous|above|prompt|rules?|guidelines?)\b/i,
  /\b(system prompt|prompt injection|jailbreak)\b/i,
  /\b(assistants?|chatbots?|claude|chatgpt|openai|anthropic|llms?|language models?|ai models?|ai agents?)\b/i,
  /\b(you are an? (ai|assistant|agent|bot|model|language model)|as an ai|tool call|function call)\b/i,
  // Money, accounts and messages.
  /\bwire\b[^.]{0,20}(money|funds|payment|transfer|\$|€|£)/i,
  /\b(venmo|paypal|zelle|bitcoin|btc|crypto(currency)?|gift cards?|bank accounts?|routing number|iban|swift code)\b/i,
  /\b(passwords?|credentials?|api keys?|credit cards?|social security|log ?in to|sign ?in to)\b/i,
  /\b(e-?mails?|inbox|text messages?|dm)\b/i,
  /\bsend\b[^.]{0,30}\b(money|payment|message|details|data|info(rmation)?|notes|contacts?)\b/i,
  /\b(pay|unlock|purchase)\b[^.]{0,40}(\$|€|£)\s?\d/i,
];

/** Whether one line reads as something other than a recipe's words. */
export function notRecipeLike(line: string, max: number): boolean {
  return line.length > max || NOT_RECIPE.some((re) => re.test(line));
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
