// Reader mode (#163): the article out of a whole page, as markdown.
//
// Readability on a linkedom document since 2026-11-16 (Eric approved
// the two packages that day); before, hand-written regexes kept the
// largest marked block, and a lazy match on a nested body ended at its
// first </div>, so whole pages came through. Hidden elements still go
// first, before anything reads the page (visibleHtml; CLAUDE.md: page
// text), and Readability gets only that visible HTML: no address, no
// JSON-LD, and linkedom fetches nothing and runs no script.
//
// The hand-written reading stays as the fallback (mainContent), for
// pages Readability finds nothing in, keeps too little of, or is too
// slow on: its time grows faster than the square of how deep a page
// nests (measured 2026-11-16: 1,000 nested divs took 2 seconds, 2,000
// took 15), and its own element limit never fires on linkedom, which
// answers getElementsByTagName('*') with nothing, so the page is
// measured here first: a bound from its tags before the parse, then the
// parsed tree itself (withinLimits).
//
// Then a clean-up pass inside the chosen block (cleanArticle) drops what
// Readability leaves in: share buttons, bylines, tag lists, newsletter
// prompts, next and previous links, tracking pixels and avatars. Then
// the same markdown as a feed's content, with a longer cap, and a last
// pass over the markdown (tidyMarkdown) for the title and repeats.
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { decode, visibleHtml } from '../attachments/import';
import { escapeStrayLt } from '../attachments/tag-scan';
import {
  type Edit,
  type El,
  applyEdits,
  attr,
  descendants,
  innerHtml,
  elementBound,
  outerHtml,
  parseTree,
  textOf,
  walk,
} from './html-tree';
import { codeButtonsAsSpans, htmlToMarkdown } from './markdown';

/** The most of a page's article kept, in characters. */
export const READER_MAX = 100_000;

/** Past any of these Readability is not tried (see the top of the file). */
export const READABILITY_LIMITS = { elements: 25_000, depth: 200, chars: 1024 * 1024 };

/**
 * The most of a page reader mode reads at all, after hidden elements
 * go: real articles' pages came to 250,000 characters and 2,300 tags at
 * the most (2026-11-16), and past these the hand-written reading too
 * slows, so the rest of a page so large is not read.
 */
export const READ_LIMITS = { elements: 50_000, chars: 2 * 1024 * 1024 };

/** Readability's block stands when it keeps this share of the marked body. */
const KEEPS_ENOUGH = 0.6;

// ---------------------------------------------------------------------
// Words in class names, ids, roles and labels.

/**
 * A class list, id or label as lowercase words: "shareButtons
 * post-tags" is share, buttons, post, tags.
 */
function wordsOf(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * What a taxonomy class may name about itself: "tag-list" is a list
 * of tags, "tag-spacex" is not.
 */
const PART = new Set([
  'list',
  'links',
  'cloud',
  'container',
  'wrap',
  'wrapper',
  'box',
  'bar',
  'block',
  'section',
  'area',
  'row',
  'buttons',
  'widget',
  'group',
  'info',
  'name',
  'bio',
  'meta',
  'card',
]);

/**
 * The words of an element's class list, id and label. A class that
 * files the post ("tag-spacex", "category-science", as WordPress marks
 * every article and every card of one) names a value, not a part.
 */
function namesOf(tag: string): string[] {
  const classes = attr(tag, 'class')
    .split(/\s+/)
    .filter((c) => {
      const m = /^(?:tag|category|author|format|status|type)-(.+)$/i.exec(c);
      return !m || PART.has(m[1].toLowerCase());
    });
  return wordsOf(`${classes.join(' ')} ${attr(tag, 'id')} ${attr(tag, 'aria-label')}`);
}

/** Words that name a part of a page around an article, never the article. */
const FRAMING = new Set([
  'share',
  'shares',
  'sharing',
  'sharebar',
  'social',
  'byline',
  'bylines',
  'author',
  'authors',
  'avatar',
  'avatars',
  'comment',
  'comments',
  'related',
  'popular',
  'trending',
  'recommended',
  'recirculation',
  'newsletter',
  'newsletters',
  'subscribe',
  'signup',
  'ad',
  'ads',
  'advert',
  'adverts',
  'advertisement',
  'advertising',
  'sponsor',
  'sponsored',
  'promo',
  'tag',
  'tags',
  'pagination',
  'pager',
  'follow',
  'footer',
  'breadcrumb',
  'breadcrumbs',
  'outbrain',
  'taboola',
  'disqus',
  'toolbar',
]);
const FRAMING_ROLES = new Set([
  'navigation',
  'complementary',
  'contentinfo',
  'banner',
  'search',
  'dialog',
  'alertdialog',
  'toolbar',
  'menu',
  'menubar',
]);
const FRAMING_ELEMENTS = new Set(['nav', 'aside', 'footer', 'form']);

/** Elements inside running text: never dropped by name. */
const PHRASING = new Set([
  'a',
  'abbr',
  'b',
  'cite',
  'code',
  'em',
  'i',
  'img',
  'label',
  'mark',
  'q',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
]);
/** Elements whose insides are text: nothing inside them goes by name. */
const TEXT_BLOCKS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'pre',
  'figcaption',
  'td',
  'th',
  'dd',
]);

/** Names that could as well be on a block of the article's own notes. */
const LOOSE_NAMES = new Set(['footer', 'notes']);
/** Names of a part that is all words and still never the article. */
const COMMENT_NAMES = new Set(['comment', 'comments', 'disqus']);

/**
 * How an element is named as framing, if it is: 'comments' goes unless
 * it holds the article's matter; 'part' (share, related, newsletter and
 * the like) also stays when it reads as text, two or more items of
 * prose; 'loose' (a footer) stays when it holds any prose at all.
 */
function namedFraming(el: El): 'comments' | 'part' | 'loose' | undefined {
  if (PHRASING.has(el.name)) return undefined;
  if (el.name === 'footer') return 'loose';
  if (FRAMING_ELEMENTS.has(el.name)) return 'part';
  if (FRAMING_ROLES.has(attr(el.tag, 'role').toLowerCase())) return 'part';
  const names = namesOf(el.tag).filter((w) => FRAMING.has(w));
  if (!names.length) return undefined;
  if (names.some((w) => COMMENT_NAMES.has(w))) return 'comments';
  return names.every((w) => LOOSE_NAMES.has(w)) ? 'loose' : 'part';
}

/** Whether an element named as framing is kept all the same for its words. */
function keptForItsWords(kind: 'comments' | 'part' | 'loose', f: Facts): boolean {
  if (f.matter) return true;
  if (kind === 'part') return f.prose >= 2;
  if (kind === 'loose') return f.prose >= 1;
  return false;
}

// ---------------------------------------------------------------------
// Reading an element's words, once for the whole tree.

function hasAncestor(el: El, stop: El, name: string): boolean {
  for (let p = el.parent; p && p !== stop; p = p.parent) if (p.name === name) return true;
  return false;
}

interface Facts {
  /** About how many characters of words it holds. */
  text: number;
  /** How many of them are inside links. */
  linked: number;
  /** Whether it holds a long paragraph, code, a quote or a table. */
  matter: boolean;
  /** How many paragraphs or list items of prose it holds: words, few of them links. */
  prose: number;
}

const MIN_PARAGRAPH = 60;
/** The fewest characters a paragraph or item of prose holds. */
const PROSE_MIN = 20;
const LONG_PARAGRAPH = 120;
const UNREAD = new Set(['script', 'style', 'template', 'title', 'textarea']);

const wordsIn = (html: string) =>
  decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim().length;

/**
 * Every element's facts, counted from the leaves up, so each character
 * is read once however deep the page nests.
 */
function readTree(html: string, root: El): Map<El, Facts> {
  const facts = new Map<El, Facts>();
  const all = [root, ...descendants(root)];
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i];
    if (UNREAD.has(el.name)) {
      facts.set(el, { text: 0, linked: 0, matter: false, prose: 0 });
      continue;
    }
    let text = 0;
    let linked = 0;
    let matter = el.name === 'pre' || el.name === 'blockquote' || el.name === 'table';
    let prose = 0;
    let at = el.innerStart;
    for (const child of el.children) {
      text += wordsIn(html.slice(at, child.start));
      const f = facts.get(child)!;
      text += f.text;
      linked += f.linked;
      matter ||= f.matter;
      prose += f.prose;
      at = child.end;
    }
    text += wordsIn(html.slice(at, el.innerEnd));
    if (el.name === 'a') linked = text;
    const f = { text, linked, matter, prose };
    if (el.name === 'p' && isParagraph(f, LONG_PARAGRAPH)) f.matter = true;
    if ((el.name === 'p' || el.name === 'li') && text >= PROSE_MIN && linked / text < 0.3) {
      f.prose++;
    }
    facts.set(el, f);
  }
  return facts;
}

/** A paragraph of the article's own words, not a line of links. */
function isParagraph(f: Facts | undefined, min = MIN_PARAGRAPH): boolean {
  return !!f && f.text >= min && f.linked / f.text < 0.5;
}

/** Past this much markup an element is not read for its shape: it is no small part. */
const SHAPE_MAX = 50_000;

// ---------------------------------------------------------------------
// Links that share the page rather than lead anywhere.

const SHARE_ADDRESS = new RegExp(
  [
    String.raw`facebook\.com/(?:sharer|share\.php|dialog/(?:share|feed))`,
    String.raw`(?:^|[/.])(?:twitter|x)\.com/(?:intent/|share\b)`,
    String.raw`reddit\.com/submit`,
    String.raw`linkedin\.com/(?:share|sharing/|shareArticle)`,
    String.raw`(?:^|//)wa\.me/`,
    String.raw`api\.whatsapp\.com/send`,
    String.raw`^whatsapp:`,
    String.raw`pinterest\.[a-z.]+/pin/create`,
    String.raw`bsky\.app/intent/`,
    String.raw`threads\.(?:net|com)/intent/`,
    String.raw`news\.ycombinator\.com/submitlink`,
    String.raw`(?:^|//)t\.me/share`,
    String.raw`tumblr\.com/(?:share|widgets/share)`,
    String.raw`getpocket\.com/(?:save|edit)`,
    String.raw`flipboard\.com/bookmarklet`,
    String.raw`/cdn-cgi/l/email-protection`,
    String.raw`#(?:comments?|respond|disqus_thread)$`,
    String.raw`^mailto:[^?]*\?(?:.*&)?(?:subject|body)=`,
  ].join('|'),
  'i',
);

/**
 * Whether a link shares the page (a sharer, an intent, an email form)
 * rather than leads anywhere.
 */
export function isShareLink(href: string): boolean {
  return SHARE_ADDRESS.test(href.trim());
}

function sharesThePage(el: El): boolean {
  const target =
    el.name === 'a'
      ? attr(el.tag, 'href')
      : attr(el.tag, 'data-href') || attr(el.tag, 'data-url') || attr(el.tag, 'data-share-url');
  return !!target && isShareLink(target);
}

// ---------------------------------------------------------------------
// Images.

const PIXEL = /(?:pixel|beacon|spacer|1x1|blank|transparent|clear)\.(?:gif|png)\b|\/pixel[/?]/i;
const PLACEHOLDER = /placeholder|lazy-?load(?:er|ing)?\.(?:gif|png|svg)|loading\.(?:gif|svg)/i;
const EMOJI = /\/emoji\/|twemoji|emoji\.(?:png|svg)/i;

/** The widest image a srcset offers up to 1600 pixels, or its narrowest past that. */
export function fromSrcset(srcset: string): string | undefined {
  const options = srcset
    .split(/,\s*(?=(?:https?:)?\/|[a-z0-9])/i)
    .map((part) => {
      const [url = '', desc = ''] = part.trim().split(/\s+/);
      const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(desc);
      // A density is taken as so many times a phone's width.
      const size = m ? Number(m[1]) * (m[2].toLowerCase() === 'x' ? 800 : 1) : 1;
      return { url, size };
    })
    .filter((o) => o.url && !o.url.startsWith('data:'));
  if (!options.length) return undefined;
  const fitting = options.filter((o) => o.size <= 1600).sort((a, b) => b.size - a.size);
  return (fitting[0] ?? options.sort((a, b) => a.size - b.size)[0]).url;
}

const quoteAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function isAvatar(tag: string): boolean {
  const src = `${attr(tag, 'src')} ${attr(tag, 'data-src')}`;
  return namesOf(tag).includes('avatar') || /gravatar\.com|\/avatars?[/_-]/i.test(src);
}

/** What an image becomes: its tag with one good source, its character, or nothing. */
function imageEdit(el: El): string | undefined {
  const tag = el.tag;
  const alt = attr(tag, 'alt');
  const given = attr(tag, 'src');
  const lazy = attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original');
  const set = fromSrcset(
    attr(tag, 'srcset') || attr(tag, 'data-srcset') || attr(tag, 'data-lazy-srcset'),
  );
  const poor = !given || given.startsWith('data:') || PLACEHOLDER.test(given) || PIXEL.test(given);
  const src = set ?? (poor ? lazy || given : given);
  // An emoji drawn as an image is its character.
  if (namesOf(tag).includes('emoji') || EMOJI.test(src)) return alt.replace(/[<&]/g, ' ');
  const width = Number(attr(tag, 'width') || NaN);
  const height = Number(attr(tag, 'height') || NaN);
  if (width <= 2 || height <= 2) return '';
  if (!src || src.startsWith('data:') || PIXEL.test(src) || PLACEHOLDER.test(src)) return '';
  if (isAvatar(tag)) return '';
  if (src === given) return undefined;
  return `<img src="${quoteAttr(src)}" alt="${quoteAttr(alt)}">`;
}

// ---------------------------------------------------------------------
// The shape of what comes before the article's first paragraph and
// after its last.

const AUTHOR_LINK = /\/(?:author|authors|people|profile|profiles|staff|contributors?|writers?)\//i;
const NEWSLETTER =
  /\bnewsletter|\bsubscribe\b|\bsign(?:ing)? up\b|\bsign-up\b|\binbox\b|\bmailing list\b|\bemail updates\b|^follow (?:us|topics|authors)\b/i;
const NEXT_PREVIOUS = /^(?:[←→«»‹›<>]\s*)?(?:next|previous|prev|older|newer)\b/i;

const siteOf = (href: string, base: string) => {
  try {
    return new URL(href, base).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
};

const authorLink = (a: El) =>
  attr(a.tag, 'rel').split(/\s+/).includes('author') || AUTHOR_LINK.test(attr(a.tag, 'href'));

function framingByShape(
  html: string,
  el: El,
  facts: Map<El, Facts>,
  base: string,
  byline?: string,
  prompts: ReadonlySet<string> = new Set(),
): boolean {
  if (el.name === 'figure' || el.name === 'figcaption' || el.name === 'img') return false;
  const f = facts.get(el)!;
  if (f.matter || el.end - el.start > SHAPE_MAX) return false;
  const inner = descendants(el);
  const images = inner.filter((d) => d.name === 'img');
  const avatar = images.some((d) => isAvatar(d.tag));
  // A picture not inside a link is the article's, never framing.
  if (!avatar && el.name !== 'a' && images.some((d) => !hasAncestor(d, el, 'a'))) return false;
  const links = el.name === 'a' ? [el] : inner.filter((d) => d.name === 'a');
  if (f.text <= 300) {
    const text = textOf(outerHtml(html, el));
    // A byline, on evidence, never on wording alone ("By the time I
    // arrived" opens a story): an author's link, an avatar, or the
    // byline Readability read and little else.
    if (text.length <= 200) {
      if (links.some(authorLink) || avatar) return true;
      if (justTheByline(text, el, byline)) return true;
      if (
        links.some((a) => NEXT_PREVIOUS.test(textOf(outerHtml(html, a)))) &&
        f.linked * 2 >= f.text
      ) {
        return true;
      }
    }
    if (prompts.has(text) || isPrompt(html, el, text)) return true;
  }
  // Mostly links to the site's own pages: tags, sections, other stories.
  if (links.length && f.text && f.linked / f.text >= 0.7) {
    const site = siteOf(base, base);
    const own = links.filter((a) => siteOf(attr(a.tag, 'href'), base) === site);
    if (own.length * 2 >= links.length) return true;
  }
  return false;
}

const DATE =
  /^(?:(?:published|updated|posted)\s*(?:on\s*)?)?(?:[a-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2} [a-z]{3,9},? \d{4}|\d{4}-\d{2}-\d{2})\b/i;

/**
 * Whether an element's words are the byline Readability read and little
 * else: "By" and the name, then perhaps a date (a `<time>`, or one
 * written out) and the words around it.
 */
function justTheByline(text: string, el: El, byline?: string): boolean {
  const by = byline
    ?.replace(/^by\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!by || by.length < 3) return false;
  const rest = text.replace(/^by\s+/i, '');
  if (!rest.startsWith(by)) return false;
  const after = rest
    .slice(by.length)
    .replace(/^[\s,|·•–-]+/, '')
    .trim();
  if (!after) return true;
  const dated = DATE.test(after) || descendants(el).some((d) => d.name === 'time');
  return dated && after.length <= 80;
}

/** Past this much markup a block is no prompt's box. */
const PROMPT_MAX = 5_000;

/** The words of the prompts to subscribe or follow in `html`, told by their means. */
export function promptsOf(html: string, tree = parseTree(html)): Set<string> {
  const prompts = new Set<string>();
  for (const el of descendants(tree)) {
    if (PHRASING.has(el.name) || el.end - el.start > PROMPT_MAX) continue;
    const text = textOf(outerHtml(html, el));
    if (isPrompt(html, el, text)) prompts.add(text);
  }
  return prompts;
}

/** Words a call to sign up says, on a link or a button. */
const SIGN_UP = /\b(?:subscribe|sign(?:ing)?[ -]?up|join|follow|get (?:the|our) newsletter)\b/i;
const SIGN_UP_ADDRESS = /subscri|sign-?up|newsletter|\/join\b|\/follow\b/i;
const PROMPT_NAMES = new Set([
  'newsletter',
  'newsletters',
  'subscribe',
  'signup',
  'subscription',
  'cta',
]);
const CONTROLS = new Set(['form', 'input', 'button', 'select', 'textarea']);

/**
 * Whether a short block is a prompt to subscribe or follow: its words
 * say so, and it carries the means (a form, a field, a button, a link
 * whose words or address are the sign-up), there or in the block around
 * it, or it sits in a block named as one. Prose about a newsletter is
 * not a prompt on its words alone.
 */
function isPrompt(html: string, el: El, text: string): boolean {
  if (text.length > 300 || !NEWSLETTER.test(text) || el.end - el.start > PROMPT_MAX) return false;
  // The block around it counts only when it is small: the prompt's
  // own box, not the article that holds it.
  const near = [el];
  const parent = el.parent;
  if (
    parent &&
    parent.name !== '#root' &&
    parent.end - parent.start <= PROMPT_MAX &&
    textOf(outerHtml(html, parent)).length <= 600
  ) {
    near.push(parent);
  }
  for (const block of near) {
    for (const d of [block, ...descendants(block)]) {
      if (CONTROLS.has(d.name) || attr(d.tag, 'role').toLowerCase() === 'button') return true;
      if (d.name !== 'a') continue;
      if (SIGN_UP_ADDRESS.test(attr(d.tag, 'href'))) return true;
      if (SIGN_UP.test(textOf(outerHtml(html, d)))) return true;
    }
  }
  for (let p: El | undefined = el, up = 0; p && up < 4; p = p.parent, up++) {
    if (namesOf(p.tag).some((w) => PROMPT_NAMES.has(w))) return true;
  }
  return false;
}

/** Whether a paragraph links its author, or opens with the byline Readability read. */
function aboutTheAuthor(html: string, el: El, byline?: string): boolean {
  const text = textOf(outerHtml(html, el));
  if (text.length > 250) return false;
  const by = byline?.replace(/^by\s+/i, '').trim();
  if (by && by.length >= 3 && text.startsWith(by)) return true;
  return descendants(el).some((d) => d.name === 'a' && authorLink(d));
}

/**
 * The article's paragraphs, with the ones that frame it set apart: an
 * author's note above the first (a line about the writer, in a block of
 * its own) and a prompt to subscribe or follow at either end.
 */
function paragraphsOf(
  html: string,
  tree: El,
  facts: Map<El, Facts>,
  byline?: string,
  prompts: ReadonlySet<string> = new Set(),
): { paragraphs: El[]; framing: El[] } {
  const paragraphs = descendants(tree).filter(
    (el) => el.name === 'p' && isParagraph(facts.get(el)),
  );
  const framing: El[] = [];
  const prompt = (el: El) => {
    if (facts.get(el)!.text > 300) return false;
    const text = textOf(outerHtml(html, el));
    return prompts.has(text) || isPrompt(html, el, text);
  };
  while (paragraphs.length > 1) {
    const [first, next] = paragraphs;
    const own = !!first.parent && next.start >= first.parent.end;
    if (prompt(first) || (own && aboutTheAuthor(html, first, byline))) {
      framing.push(paragraphs.shift()!);
    } else break;
  }
  while (paragraphs.length > 1 && prompt(paragraphs[paragraphs.length - 1])) {
    framing.push(paragraphs.pop()!);
  }
  return { paragraphs, framing };
}

const dropped = (el: El): Edit => ({ start: el.start, end: el.end, text: ' ' });

/**
 * `html`, the article's block, with the page's framing taken out of it:
 * parts named as framing, share links, and, before the first paragraph
 * or after the last, what is shaped like a byline, a list of the site's
 * links, a newsletter prompt or a next and previous link. A part holding
 * a long paragraph, code, a quote or a table is never dropped by its
 * name. Images get one good source each; pixels, placeholders and
 * avatars go. Conservative: losing a paragraph is worse than keeping a
 * stray line.
 */
export function cleanArticle(
  html: string,
  base: string,
  byline?: string,
  pagePrompts: Iterable<string> = [],
): string {
  // Named parts and share links first, so the shapes below are read on
  // what is left.
  const tree0 = parseTree(html);
  const facts0 = readTree(html, tree0);
  const named: Edit[] = [];
  const stack: [El, boolean][] = tree0.children.map((c) => [c, false]);
  while (stack.length) {
    const [el, inText] = stack.pop()!;
    const kind = inText ? undefined : namedFraming(el);
    const byName = !!kind && !keptForItsWords(kind, facts0.get(el)!);
    if (byName || sharesThePage(el)) named.push(dropped(el));
    else {
      const text = inText || TEXT_BLOCKS.has(el.name);
      for (const child of el.children) stack.push([child, text]);
    }
  }
  // The prompts are told by their buttons and forms, which the named
  // parts take with them, and Readability before: found on the page
  // (`pagePrompts`) and here, before those go.
  const prompts = promptsOf(html, tree0);
  for (const text of pagePrompts) prompts.add(text);
  const html1 = applyEdits(html, named);
  // Then the paragraphs that frame it: an author's note, a prompt.
  const tree1 = parseTree(html1);
  const once = applyEdits(
    html1,
    paragraphsOf(html1, tree1, readTree(html1, tree1), byline, prompts).framing.map(dropped),
  );
  const tree = parseTree(once);
  const facts = readTree(once, tree);
  const edits: Edit[] = [];
  const { paragraphs } = paragraphsOf(once, tree, facts, byline, prompts);
  const first = paragraphs[0];
  const last = paragraphs[paragraphs.length - 1];
  // With no paragraph at all (a front page) there is no before or after.
  if (first && last) {
    walk(tree, (el) => {
      const outside = el.end <= first.start || el.start >= last.end;
      if (outside && framingByShape(once, el, facts, base, byline, prompts)) {
        edits.push(dropped(el));
        return false;
      }
      return true;
    });
  }
  for (const el of descendants(tree)) {
    if (el.name !== 'img') continue;
    const text = imageEdit(el);
    if (text !== undefined) edits.push({ start: el.start, end: el.end, text });
  }
  return applyEdits(once, edits);
}

// ---------------------------------------------------------------------
// Before Readability.

/** What ends the climb from an avatar to the words beside it. */
function holdsMore(el: El, facts: Map<El, Facts>): boolean {
  return [el, ...descendants(el)].some(
    (d) =>
      /^h[1-6]$/.test(d.name) ||
      d.name === 'figure' ||
      d.name === 'pre' ||
      (d.name === 'img' && !isAvatar(d.tag)) ||
      (d.name === 'p' && facts.get(d)!.text >= MIN_PARAGRAPH),
  );
}

const STOPS = new Set(['#root', 'html', 'body', 'main', 'article']);
const MAX_AVATARS = 20;

/**
 * The visible page made ready for Readability: a code highlighter's
 * buttons become spans so the code keeps its words, a code block loses
 * its class and id (Readability drops a block whose class says
 * "footer", and highlighters write "no-footer"), and an avatar goes
 * with the few words beside it (an author's initials and name), which
 * Readability otherwise glues onto the first sentence.
 */
function prepare(visible: string): string {
  const html = codeButtonsAsSpans(visible);
  const tree = parseTree(html);
  const facts = readTree(html, tree);
  const edits: Edit[] = [];
  // One walk, knowing whether it is inside running text; a page has an
  // author or two, so past a few avatars the rest are left as they are.
  let avatars = 0;
  const stack: [El, boolean][] = tree.children.map((c) => [c, false]);
  while (stack.length) {
    const [el, inText] = stack.pop()!;
    if (el.name === 'pre') edits.push({ start: el.start, end: el.innerStart, text: '<pre>' });
    const avatar =
      el.name === 'img' ? isAvatar(el.tag) : wordsOf(attr(el.tag, 'class')).includes('avatar');
    if (avatar && !inText && avatars < MAX_AVATARS) {
      avatars++;
      let cut = el;
      for (let up = 0; up < 6; up++) {
        const parent = cut.parent;
        if (!parent || STOPS.has(parent.name) || facts.get(parent)!.text > 80) break;
        if (parent.end - parent.start > SHAPE_MAX || holdsMore(parent, facts)) break;
        cut = parent;
      }
      edits.push(dropped(cut));
      continue;
    }
    const text = inText || TEXT_BLOCKS.has(el.name);
    for (const child of el.children) stack.push([child, text]);
  }
  return applyEdits(html, edits);
}

// ---------------------------------------------------------------------
// The hand-written reading, the fallback.

/** Elements that frame an article but are never it. */
const BOILERPLATE = new Set([
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'script',
  'style',
  'noscript',
  'iframe',
  'template',
  'dialog',
  'menu',
]);

/** Where pages mark their article body by class or id. */
const BODY_NAMES =
  /[\s_-](?:entry-content|article-body|articlebody|article__body|article-content|post-content|post-body|postbody|content-body|story-body|story-content|e-content)[\s_-]/i;

/** The marks, most specific first. */
const TIERS: ((el: El) => boolean)[] = [
  (el) => attr(el.tag, 'itemprop').toLowerCase() === 'articlebody',
  (el) => BODY_NAMES.test(` ${attr(el.tag, 'class')} ${attr(el.tag, 'id')} `),
  (el) => el.name === 'article',
  (el) => attr(el.tag, 'role').toLowerCase() === 'main' || el.name === 'main',
];

/**
 * The page's own marked article body in visible HTML: the most specific
 * mark that holds a fair share of the page, the largest of its kind; or
 * the body, `marked` false, when none does.
 */
function markedBody(visible: string): { html: string; marked: boolean } {
  const edits: Edit[] = [];
  walk(parseTree(visible), (el) => {
    if (!BOILERPLATE.has(el.name)) return true;
    edits.push(dropped(el));
    return false;
  });
  const html = applyEdits(visible, edits);
  const tree = parseTree(html);
  const facts = readTree(html, tree);
  const all = descendants(tree);
  const bodyEl = all.find((el) => el.name === 'body') ?? tree;
  const total = facts.get(bodyEl)!.text;
  for (const tier of TIERS) {
    const best = all.filter(tier).sort((a, b) => facts.get(b)!.text - facts.get(a)!.text)[0];
    // A marked block that holds a fair share of the page is the article;
    // a tiny one (a teaser, a comment) is not.
    if (best && facts.get(best)!.text >= Math.min(1000, total * 0.3)) {
      return { html: innerHtml(html, best), marked: true };
    }
  }
  return { html: innerHtml(html, bodyEl), marked: false };
}

/** The HTML of the page's article by hand, best effort; hidden elements first. */
export function mainContent(html: string): string {
  return markedBody(visibleHtml(html)).html;
}

// ---------------------------------------------------------------------
// The lead image.

/**
 * An image file's name without its size, density and type:
 * "dc-comics-336x189.jpg" is dc-comics.
 */
function imageStem(url: string): string {
  const file = url.split(/[?#]/)[0].split('/').pop() ?? '';
  let name = file;
  try {
    name = decodeURIComponent(file);
  } catch {
    // as written
  }
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/@\d+x$/i, '')
    .replace(/-\d+x\d+$/, '')
    .toLowerCase();
}

function imageSources(tag: string): string[] {
  const set = `${attr(tag, 'srcset')},${attr(tag, 'data-srcset')}`
    .split(/,\s*/)
    .map((s) => s.trim().split(/\s+/)[0]);
  return [attr(tag, 'src'), attr(tag, 'data-src'), attr(tag, 'data-lazy-src'), ...set].filter(
    Boolean,
  );
}

const showsStem = (tag: string, stem: string) =>
  imageSources(tag).some((s) => imageStem(s).startsWith(stem));

/** Where the block's first paragraph is in the page, found by its first words. */
function paragraphAt(
  page: string,
  pageTree: El,
  block: string,
  byline?: string,
): number | undefined {
  const blockTree = parseTree(block);
  const firstP = paragraphsOf(block, blockTree, readTree(block, blockTree), byline).paragraphs[0];
  if (!firstP) return undefined;
  const opening = textOf(innerHtml(block, firstP)).slice(0, 40);
  for (const el of descendants(pageTree)) {
    if (el.name === 'p' && textOf(innerHtml(page, el)).startsWith(opening)) return el.start;
  }
  return undefined;
}

/**
 * The page's lead image when `block` left it out: the image the page's
 * own metadata names (og:image), placed above the article's first
 * paragraph (a featured image, a comic's panels), with its figure and
 * caption, or its link. Undefined when there is none or the block has it.
 */
function leadImage(page: string, block: string, byline?: string): string | undefined {
  const tree = parseTree(page);
  const facts = readTree(page, tree);
  const all = descendants(tree);
  const meta = all.find(
    (el) =>
      el.name === 'meta' &&
      /^(?:og:image|twitter:image)$/i.test(attr(el.tag, 'property') || attr(el.tag, 'name')),
  );
  const stem = meta ? imageStem(attr(meta.tag, 'content')) : '';
  if (stem.length < 4) return undefined;
  const inBlock = descendants(parseTree(block)).filter((el) => el.name === 'img');
  if (inBlock.some((el) => showsStem(el.tag, stem))) return undefined;
  const bodyStart = paragraphAt(page, tree, block, byline);
  if (bodyStart === undefined) return undefined;
  const shown = all.filter(
    (el) =>
      el.name === 'img' && el.end <= bodyStart && showsStem(el.tag, stem) && !isAvatar(el.tag),
  );
  if (!shown.length) return undefined;
  // The images together: the smallest element holding them all, when it
  // holds few words; else the first alone.
  let lead: El = shown[0];
  if (shown.length > 1) {
    const holds = (el: El) => shown.every((s) => s.start >= el.start && s.end <= el.end);
    let common = shown[0].parent;
    while (common && !holds(common)) common = common.parent;
    if (common && common.name !== '#root' && facts.get(common)!.text <= 200) {
      lead = common;
    }
  }
  // Its figure, or the block beside it that holds a caption.
  const captioned = (el: El) =>
    descendants(el).some(
      (d) =>
        d.name === 'figcaption' || namesOf(d.tag).some((w) => w === 'caption' || w === 'credit'),
    );
  for (let p = lead.parent, up = 0; p && p.name !== '#root' && up < 4; p = p.parent, up++) {
    if (facts.get(p)!.text > 400 || p.end - p.start > SHAPE_MAX) break;
    if (p.name === 'figure' || captioned(p)) {
      lead = p;
      break;
    }
  }
  if (lead.parent?.name === 'a' && facts.get(lead.parent)!.text <= 200) {
    lead = lead.parent;
  }
  return outerHtml(page, lead);
}

// ---------------------------------------------------------------------
// The article.

/** How many characters a block's paragraphs hold: what a reader reads. */
function proseOf(html: string): number {
  const tree = parseTree(html);
  const facts = readTree(html, tree);
  let n = 0;
  walk(tree, (el) => {
    if (el.name !== 'p') return true;
    n += facts.get(el)!.text;
    return false;
  });
  return n;
}

interface Walked {
  firstElementChild: Walked | null;
  nextElementSibling: Walked | null;
  parentElement: Walked | null;
}

/**
 * Whether the parsed document is within Readability's limits, read off
 * the document itself (review, 2026-11-16): a count of the page's tags
 * disagrees with the parser (`<div/>` is a real open element in HTML, as
 * are tags left open, and a parser nests what it implies), and it is
 * the parser's tree Readability is slow on. A loop, stopping once past.
 */
function withinLimits(root: Walked | null): boolean {
  let elements = 0;
  let depth = 0;
  for (let el = root; el;) {
    if (++elements > READABILITY_LIMITS.elements || depth > READABILITY_LIMITS.depth) return false;
    if (el.firstElementChild) {
      el = el.firstElementChild;
      depth++;
      continue;
    }
    while (el && el !== root && !el.nextElementSibling) {
      el = el.parentElement;
      depth--;
    }
    el = el && el !== root ? el.nextElementSibling : null;
  }
  return true;
}

function readability(prepared: string): { html: string; byline?: string } | undefined {
  try {
    const { document } = parseHTML(prepared);
    if (!withinLimits(document.documentElement as unknown as Walked)) return undefined;
    const article = new Readability(document as unknown as Document, {
      charThreshold: 300,
      keepClasses: true,
      disableJSONLD: true,
      maxElemsToParse: READABILITY_LIMITS.elements,
    }).parse();
    if (!article?.content) return undefined;
    return { html: article.content, ...(article.byline ? { byline: article.byline } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The page's article as HTML, and its byline when Readability read one:
 * Readability's block when it keeps most of the page's marked body, else
 * the marked body by hand; the lead image put back when left out.
 */
export function extractArticle(html: string): {
  html: string;
  byline?: string;
  prompts?: string[];
} {
  // Hidden elements first, before anything reads the page (CLAUDE.md:
  // hidden page text is dropped before anything reads it); then every
  // `<` that starts no tag made a word, so no pattern below can run
  // across the page from it.
  const whole = escapeStrayLt(visibleHtml(html));
  // Sized before anything else reads it: past READ_LIMITS the rest is
  // cut. The parse grows faster than the page past Readability's limits
  // (100,000 nested divs took 8 seconds), so a page that could make more
  // elements than it takes is not parsed at all; the parsed tree is
  // then checked exactly (withinLimits).
  const bound = elementBound(whole, READ_LIMITS.elements);
  const cut = Math.min(bound.at, READ_LIMITS.chars);
  // A tag the cut ends in half starts nothing any more: made words too.
  const visible = cut < whole.length ? escapeStrayLt(whole.slice(0, cut)) : whole;
  const small =
    visible.length <= READABILITY_LIMITS.chars && bound.count <= READABILITY_LIMITS.elements;
  const prepared = small ? prepare(visible) : codeButtonsAsSpans(visible);
  const marked = markedBody(prepared);
  const read = small ? readability(prepared) : undefined;
  const chosen =
    read && (!marked.marked || proseOf(read.html) >= proseOf(marked.html) * KEEPS_ENOUGH)
      ? read
      : { html: marked.html };
  const lead = leadImage(prepared, chosen.html, chosen.byline);
  // The page's prompts to subscribe, read while their forms are there.
  const prompts = small ? [...promptsOf(prepared)] : [];
  return {
    ...chosen,
    ...(lead ? { html: `<div>${lead}</div>${chosen.html}` } : {}),
    ...(prompts.length ? { prompts } : {}),
  };
}

/** A heading or a title as plain words, for comparing the two. */
const plainWords = (s: string) =>
  s
    .replace(/^#+\s*/, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Repeats count only for blocks this long: a short line can recur on purpose. */
const REPEAT_MIN = 40;
/** How many blocks open an article, for repeats. */
const OPENING = 3;

/**
 * The reader's markdown tidied: a first heading that is the item's own
 * title goes (the app shows the title above), a paragraph of 40 or more
 * characters or an image printed again exactly goes when it is right
 * after itself or repeats the first blocks near the top (a dek twice, a
 * lead image twice), and a heading left with nothing under it goes.
 * Short lines, lists, quotes and code are never deduplicated.
 */
export function tidyMarkdown(md: string, title?: string): string {
  // Blocks, a code fence kept whole: it opens with three or more
  // backticks and closes only with as many.
  const blocks: string[] = [];
  let open: string[] | undefined;
  let fence = 0;
  for (const part of md.split(/\n{2,}/)) {
    for (const line of part.split('\n')) {
      const run = /^`{3,}/.exec(line)?.[0].length ?? 0;
      if (!fence) fence = run;
      else if (run >= fence && /^`+\s*$/.test(line)) fence = 0;
    }
    if (open) open.push(part);
    else if (fence) open = [part];
    else blocks.push(part);
    if (open && !fence) {
      blocks.push(open.join('\n\n'));
      open = undefined;
    }
  }
  if (open) blocks.push(open.join('\n\n'));
  const isHeading = (b: string) => /^#{1,6} /.test(b) && !b.includes('\n');
  const isImage = (b: string) => /^\[?!\[/.test(b) && !b.includes('\n');
  const isProse = (b: string) => !/^(?:#{1,6} |> |- |\d+\. |`{3,}|---$)/.test(b);
  let titled = !title?.trim();
  const kept: string[] = [];
  for (const block of blocks) {
    if (!titled && isHeading(block)) {
      titled = true;
      if (plainWords(block) === plainWords(title!)) continue;
    }
    // A line of one image printed twice ("![a](u) ![a](u)") is the image once.
    const b = isImage(block) ? [...new Set(block.split(/ (?=\[?!\[)/))].join(' ') : block;
    // A repeat goes only beside its original, or when the article's
    // first blocks repeat near the top (a dek or a lead image printed
    // twice); a refrain later in an essay, or an image shown again, is
    // the writer's (review, 2026-11-16).
    const repeatable = isImage(b) || (isProse(b) && b.length >= REPEAT_MIN);
    const again =
      kept[kept.length - 1] === b ||
      (kept.length < OPENING * 2 && kept.slice(0, OPENING).includes(b));
    if (repeatable && again) continue;
    kept.push(b);
  }
  // A heading with nothing under it before the next of its rank or higher.
  const rank = (b: string) => (isHeading(b) ? /^#+/.exec(b)![0].length : 0);
  const out: string[] = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    const n = rank(kept[i]);
    if (n && (out[0] === undefined || (rank(out[0]) && rank(out[0]) <= n))) continue;
    out.unshift(kept[i]);
  }
  return out.join('\n\n');
}

/** The page's article as markdown, resolved against `url`; `title` is the item's own. */
export function readerMarkdown(html: string, url: string, title?: string): string {
  const article = extractArticle(html);
  return tidyMarkdown(
    htmlToMarkdown(
      cleanArticle(article.html, url, article.byline, article.prompts),
      url,
      READER_MAX,
    ),
    title,
  );
}
