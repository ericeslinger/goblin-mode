// The word index for search across every article (#175), pure over
// text. The fetcher writes an item's `terms` from its title and text:
// lowercase words of letters and digits, the commonest English words
// left out, each lightly stemmed so "chairs" finds "chair" and
// "glazing" finds "glaze", distinct, in first-seen order, capped. A
// query is read the same way, so the two always agree; the stemmer
// need only be consistent, not right.

/** The most terms an item carries (`FeedItem.terms`). */
export const TERMS_MAX = 200;
/** The longest term kept; longer runs are ids and hashes, not words. */
export const TERM_MAX_LENGTH = 40;
/** The most terms a query is read as. */
export const QUERY_TERMS_MAX = 12;

/** Too common to find anything by. */
const STOP = new Set(
  (
    'a an and are as at be been but by can did do does for from had has have he her his i if ' +
    'in into is it its just me my no not of on or our out over she so than that the their them ' +
    'then there these they this those to too up us was we were what when which who why will ' +
    'with you your'
  ).split(' '),
);

const LETTERS = /^\p{L}+$/u;
const VOWEL = /[aeiouy]/;

/**
 * A light suffix stripper (no library): plurals, -ed and -ing, a
 * doubled consonant left by them undone, and a final e dropped, so
 * "glaze", "glazes", "glazed" and "glazing" are one term. Words of
 * three letters or fewer, and anything with a digit, are left alone.
 */
export function stem(word: string): string {
  if (word.length <= 3 || !LETTERS.test(word)) return word;
  let w = word;
  let cut = false;
  if (/ie[sd]$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (/ing$/.test(w) && w.length - 3 >= 3 && VOWEL.test(w.slice(0, -3))) {
    w = w.slice(0, -3);
    cut = true;
  } else if (/[^e]ed$/.test(w) && w.length - 2 >= 3 && VOWEL.test(w.slice(0, -2))) {
    w = w.slice(0, -2);
    cut = true;
  } else if (/[^sui]s$/.test(w)) w = w.slice(0, -1);
  // "running" to "run", but "falling" stays "fall" and "missed" "miss".
  if (cut && /([^aeioulsz])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** The words of a text, lowercased, link targets and addresses left out. */
function words(text: string): string[] {
  const plain = text
    .normalize('NFC')
    .toLowerCase()
    // A markdown link's or image's target is an address, not words.
    .replace(/\]\([^)\s]*\)/g, '] ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    // "don't" is one word, "dont", in the text and in a query alike.
    .replace(/(\p{L})['’](\p{L})/gu, '$1$2');
  return plain.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/**
 * An item's terms (#175): its title's words, then its text's, each
 * stemmed, at least two and at most forty characters, no stop words,
 * distinct, first seen first, at most `max`.
 */
export function termsOf(title: string, text: string, max = TERMS_MAX): string[] {
  const out = new Set<string>();
  for (const source of [title, text]) {
    for (const raw of words(source)) {
      if (out.size >= max) return [...out];
      if (raw.length < 2 || raw.length > TERM_MAX_LENGTH || STOP.has(raw)) continue;
      const term = stem(raw);
      if (term.length >= 2) out.add(term);
    }
  }
  return [...out];
}

/** A query's terms, read as an item's are; none for a query of only stop words. */
export function queryTerms(query: string): string[] {
  return termsOf('', query, QUERY_TERMS_MAX);
}

/**
 * The term to ask the index for (#175): the longest, as the rarest.
 * There is no table of how often each word occurs, and longer words
 * are rarer on the whole, so this is a guess that costs nothing; the
 * other terms are checked on the documents that come back.
 */
export function rarestTerm(terms: readonly string[]): string | undefined {
  return terms.reduce<string | undefined>(
    (best, t) => (!best || t.length > best.length ? t : best),
    undefined,
  );
}

/**
 * A stored item's terms: its title, then the page's text when reader
 * mode kept it (#163), then what the feed gave, as one index.
 */
export function termsOfItem(d: { title?: unknown; content?: unknown; readerContent?: unknown }) {
  const text = [d.readerContent, d.content].filter((t) => typeof t === 'string' && t).join('\n');
  return termsOf(typeof d.title === 'string' ? d.title : '', text);
}
