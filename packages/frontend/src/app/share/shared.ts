/**
 * What Android's share sheet sends (Share to Mossgoblin, 2026-11-14;
 * DESIGN.md). The manifest's share target posts title, text and url
 * (and files, #46) to /share; `sw.js`, or the Worker before it is
 * installed, sends the words on to /share?title&text&url&at, `at` the
 * moment it took them. What the fields hold depends on the app:
 *
 * - Chrome sharing a page: `title` is the page's, `text` its address,
 *   `url` usually empty.
 * - Chrome sharing selected text: `text` is the selection, often with
 *   the page's address after it.
 * - Other apps: a link somewhere inside free text, or in `url`.
 */
export interface Shared {
  /** The page's or the app's title, trimmed; may be empty. */
  title: string;
  /** The words shared, the link taken out if it only rode along; may be empty. */
  words: string;
  /** The link shared, http or https only; may be empty. */
  link: string;
  /** Tells this share from a reload of it (see `shareKey`). */
  key: string;
}

/** Where a link ends, beyond which a trailing mark is the sentence's. */
const LINK = /\bhttps?:\/\/[^\s<>"]+/gi;

/** `text`, trimmed, if it is a link: http or https only; else empty. */
export function webLink(text: string): string {
  const link = text.trim();
  try {
    const url = new URL(link);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !/\s/.test(link) ? link : '';
  } catch {
    return '';
  }
}

/** Whether two links name the same address. */
function sameLink(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** A link found in prose loses the full stop or bracket after it. */
function trimLink(raw: string): string {
  let link = raw.replace(/[.,;:!?'"*_]+$/, '');
  // A closing bracket is the link's own only when it opened one too.
  while (/[)\]]$/.test(link)) {
    const close = link.at(-1)!;
    const open = close === ')' ? '(' : '[';
    if (link.split(open).length >= link.split(close).length) break;
    link = link.slice(0, -1).replace(/[.,;:!?'"*_]+$/, '');
  }
  return link;
}

/**
 * The link in shared text: the one it ends or starts with (a page's
 * address after a selection, or before a comment), else the first.
 */
function linkIn(text: string): { link: string; start: number; end: number } | undefined {
  const found = [...text.matchAll(LINK)].map((m) => {
    const link = trimLink(m[0]);
    return { link, start: m.index, end: m.index + link.length };
  });
  if (!found.length) return undefined;
  const last = found.at(-1)!;
  if (!text.slice(last.end).trim()) return last;
  return found[0];
}

/** Quotes Chrome puts round a selection, once the link is gone from after it. */
function unquote(text: string): string {
  const m = /^"([\s\S]*)"$/.exec(text) ?? /^“([\s\S]*)”$/.exec(text);
  return m ? m[1].trim() : text;
}

/**
 * What a share brought, or undefined when it brought nothing to keep.
 * The link is `url` when that is one, else the link in `text`; a link
 * at the start or end of the text is taken out of the words, which
 * otherwise stay as they were sent.
 */
export function parseShare(params: {
  title?: string | null;
  text?: string | null;
  url?: string | null;
  at?: string | null;
}): Shared | undefined {
  const title = (params.title ?? '').trim();
  const text = (params.text ?? '').replace(/\r\n?/g, '\n').trim();
  let link = webLink(params.url ?? '');
  let words = text;
  const inText = linkIn(text);
  if (inText) {
    const edge = !text.slice(0, inText.start).trim() || !text.slice(inText.end).trim();
    // The url's own address in the text too: said once, as the link.
    const same = !link || sameLink(inText.link, link);
    if (!link) link = webLink(inText.link);
    if (edge && same && link) {
      words = unquote((text.slice(0, inText.start) + text.slice(inText.end)).trim());
    }
  }
  // A title that only repeats the link says nothing more.
  const named = title && !sameLink(title, link) ? title : '';
  if (!named && !words && !link) return undefined;
  return { title: named, words, link, key: shareKey(params) };
}

/**
 * Which share this is: the moment `sw.js` took it, which a reload of
 * the same address repeats; or, for an address made any other way, its
 * fields, so opening it twice still files it once.
 */
export function shareKey(params: {
  title?: string | null;
  text?: string | null;
  url?: string | null;
  at?: string | null;
}): string {
  const at = (params.at ?? '').trim();
  if (/^\d+$/.test(at)) return `at:${at}`;
  return `fields:${JSON.stringify([params.title ?? '', params.text ?? '', params.url ?? ''])}`;
}

/**
 * The share as a note's text, one line each: the title, unless the
 * words have it, then the words, then the link, unless the words have
 * it. As a share became a note before (#42): `sharedText` in launch.
 */
export function shareNoteText(shared: Pick<Shared, 'title' | 'words' | 'link'>): string {
  const { title, words, link } = shared;
  return [
    ...(title && !words.includes(title) ? [title] : []),
    ...(words ? [words] : []),
    ...(link && !words.includes(link) ? [link] : []),
  ].join('\n');
}

/**
 * Whether the page was opened by this app or the share sheet, not from
 * another site's page, whose link must not plant words a later Claude
 * would read (review on #98). An app's referrer (android-app://...) is
 * this device.
 */
export function openedHere(referrer: string, origin: string): boolean {
  if (!referrer) return true;
  try {
    const from = new URL(referrer);
    if (from.protocol !== 'http:' && from.protocol !== 'https:') return true;
    return from.origin === origin;
  } catch {
    return false;
  }
}
