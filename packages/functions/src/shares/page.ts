// The public page of a shared note, `/s/<shareId>` (2026-11-26, Eric;
// DESIGN.md, Sharing a public copy). Rendered here, in a function,
// rather than in the Worker, whose CPU allowance a note's markdown can
// pass (2026-11-26). The Worker forwards `/s/*` here after refusing a
// malformed id itself, and puts the page's headers on what comes back.
//
// The share is read with the admin SDK: the rules let no one but its
// owner read it. A share is shown only when its owner is this
// deployment's owner (OWNER_UID, as the MCP server's), so a stranger who
// signs in and writes a share of their own never has it shown on this
// domain. A share that is not there, was stopped, is not the owner's, or
// whose id is not a share id's shape gets one and the same 404. The page
// has no scripts at all; the body goes through html.ts. Nothing on it
// names the owner, the note or any other share. Over a small interface,
// so it runs in specs.
import { plainText } from '@mossgoblin/editor/grammar';
import {
  NOT_FOUND_PAGE,
  SHARE_HEADERS,
  UNAVAILABLE_PAGE,
  escapeHtml,
  ingredients,
  isShareId,
  methodSteps,
  page,
  shareIdOf,
} from '@mossgoblin/schema';
import { safeHref, shareBodyHtml } from './html';

/** The copy the page shows: what the share's document holds that is shown. */
export interface PublicShare {
  kind: 'note' | 'recipe';
  title: string;
  body: string;
  source?: string;
}

/** Reads a share's document, or undefined when it is not there. */
export type ShareReader = (id: string) => Promise<Record<string, unknown> | undefined>;

/**
 * Share `id` as the page shows it: the copy, `missing` when there is
 * none to show (not there, not a share's shape, or not the owner's), or
 * `unavailable` when it could not be read.
 */
export async function loadShare(
  id: string,
  read: ShareReader,
  ownerUid: string | undefined,
): Promise<PublicShare | 'missing' | 'unavailable'> {
  if (!isShareId(id) || !ownerUid) return 'missing';
  let doc: Record<string, unknown> | undefined;
  try {
    doc = await read(id);
  } catch {
    return 'unavailable';
  }
  if (!doc || doc['owner'] !== ownerUid) return 'missing';
  const { kind, title, body } = doc;
  if (
    (kind !== 'note' && kind !== 'recipe') ||
    typeof title !== 'string' ||
    typeof body !== 'string'
  ) {
    return 'missing';
  }
  const source = kind === 'recipe' && typeof doc['source'] === 'string' ? doc['source'] : '';
  const link = source && safeHref(source);
  return { kind, title, body, ...(link && /^https?:/.test(link) ? { source: link } : {}) };
}

/**
 * JSON for inside a `<script>` element: `<`, `>` and `&` as escapes, so
 * no `</script>` or `<!--` can end or bend it, and the two line
 * separators JavaScript once refused in strings.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** A line of a recipe as plain words, for its JSON-LD. */
const words = (line: string) => plainText(line).replace(/\s+/g, ' ').trim();

/**
 * A recipe share as schema.org Recipe JSON-LD, the format recipe sites
 * publish and recipe apps (and this app's importer) read: its name,
 * ingredients and steps from the body's Ingredients and Method sections,
 * and the page it is based on.
 */
export function recipeJsonLd(share: PublicShare): Record<string, unknown> {
  const steps = methodSteps(share.body).map(words).filter(Boolean);
  return {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: share.title,
    recipeIngredient: ingredients(share.body)
      .map((i) => words(i.text))
      .filter(Boolean),
    recipeInstructions: steps.map((text) => ({ '@type': 'HowToStep', text })),
    ...(share.source ? { isBasedOn: share.source } : {}),
  };
}

/** The page for a share: its title, a recipe's source, its body. */
export function renderSharePage(given: PublicShare): string {
  // The source is checked here too, not only by loadShare: http and
  // https alone reach the link and the JSON-LD (review of #343).
  const { source: raw, ...rest } = given;
  const href = raw ? safeHref(raw) : undefined;
  const share: PublicShare = {
    ...rest,
    ...(href && /^https?:/.test(href) ? { source: href } : {}),
  };
  const title = share.title.trim() || 'Untitled';
  let head = `<meta property="og:title" content="${escapeHtml(title)}">\n`;
  if (share.kind === 'recipe') {
    head += `<script type="application/ld+json">${scriptJson(recipeJsonLd({ ...share, title }))}</script>\n`;
  }
  let main = `<h1>${escapeHtml(title)}</h1>\n`;
  if (share.source) {
    let host = share.source;
    try {
      host = new URL(share.source).host.replace(/^www\./, '');
    } catch {
      // Kept as it is.
    }
    main +=
      `<p class="from">From <a href="${escapeHtml(share.source)}" ` +
      `rel="noopener noreferrer nofollow">${escapeHtml(host)}</a></p>\n`;
  }
  return page(title, main + shareBodyHtml(share.body), head);
}

/** An answer to a request on `/s/`: status, headers and body (none for HEAD). */
export interface ShareAnswer {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Answers `method` on `pathname`: GET or HEAD of `/s/<id>`, an optional
 * trailing slash, with the page, the one 404, or a 503 to try again.
 */
export async function answerShare(
  method: string,
  pathname: string,
  read: ShareReader,
  ownerUid: string | undefined,
): Promise<ShareAnswer> {
  const headers = { ...SHARE_HEADERS };
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { ...headers, allow: 'GET, HEAD' }, body: 'GET only' };
  }
  const body = (html: string) => (method === 'HEAD' ? null : html);
  const found = await loadShare(shareIdOf(pathname) ?? '', read, ownerUid);
  if (found === 'missing') return { status: 404, headers, body: body(NOT_FOUND_PAGE) };
  if (found === 'unavailable') {
    return {
      status: 503,
      headers: { ...headers, 'retry-after': '60' },
      body: body(UNAVAILABLE_PAGE),
    };
  }
  return { status: 200, headers, body: body(renderSharePage(found)) };
}
