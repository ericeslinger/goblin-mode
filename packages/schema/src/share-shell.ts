// The fixed parts of a shared note's public page, `/s/<shareId>`
// (2026-11-26; DESIGN.md, Sharing a public copy): its stylesheet, its
// security headers, its shell and its one 404. Shared by the function
// that renders the page (packages/functions/src/shares) and the Worker,
// which refuses a malformed id itself, with the same 404, before
// forwarding, and puts these headers on whatever comes back. Nothing
// imported: the Worker reads this file on its own.
import { SHARE_PATH, isShareId } from './shares';

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** `text` with every character HTML gives meaning to written as an entity. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Whether a path is the public page's, `/s/...`, whatever follows. */
export function isSharePath(pathname: string): boolean {
  return pathname === '/s' || pathname.startsWith(SHARE_PATH);
}

/** The share id of a public page's path, `/s/<id>` or `/s/<id>/`, or undefined. */
export function shareIdOf(pathname: string): string | undefined {
  const id = /^\/s\/([^/]*)\/?$/.exec(pathname)?.[1];
  return isShareId(id) ? id : undefined;
}

/** The page's one stylesheet: the app's default theme (Herbarium), light and dark. */
export const SHARE_STYLE = `
:root { color-scheme: light dark; --bg: #faf8f2; --surface: #fffdf8; --ink: #161616;
  --quiet: #595954; --rule: #d8d4c8; --accent: #b23a2e; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #121311; --surface: #1a1b18; --ink: #eae7de; --quiet: #a4a096;
    --rule: #34352f; --accent: #e07a6b; }
}
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--ink); }
body { margin: 0; padding: 32px 16px 48px; font: 18px/1.6 Georgia, "Times New Roman", serif;
  overflow-wrap: anywhere; }
main { max-width: 40rem; margin: 0 auto; }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 24px; }
h2, h3, h4, h5, h6 { line-height: 1.25; margin: 32px 0 8px; }
a { color: var(--accent); }
.from { color: var(--quiet); margin: -16px 0 24px; font-size: 16px; }
ul, ol { padding-left: 1.5em; }
ul.tasks { list-style: none; padding-left: 0.25em; }
li.task input { margin: 0 0.4em 0 0; vertical-align: -0.1em; }
blockquote { margin: 16px 0; padding: 0 16px; border-left: 3px solid var(--rule); color: var(--quiet); }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.85em;
  background: var(--surface); padding: 0 0.2em; }
pre { overflow-x: auto; background: var(--surface); padding: 12px; border: 1px solid var(--rule); }
pre code { padding: 0; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 32px 0; }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--rule); padding: 4px 8px; text-align: left; }
footer { max-width: 40rem; margin: 48px auto 0; padding-top: 16px; border-top: 1px solid var(--rule);
  color: var(--quiet); font-size: 14px; }
`.trim();

/**
 * SHARE_STYLE's CSP source, its SHA-256 in base64; a spec pins it to
 * the stylesheet, so a change to one without the other fails the gate.
 */
export const SHARE_STYLE_HASH = "'sha256-dGp6ihEcC7a+7GEqUT1yZ34NBWPsuv5ARWy0Fxc7F7I='";

/**
 * Headers for every answer on `/s/`: a policy that allows the one
 * stylesheet and nothing else (no script, no frame, no form, no base),
 * never indexed, no referrer sent on, and never cached, so Stop sharing
 * takes effect at the next load.
 */
export const SHARE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    `default-src 'none'; style-src ${SHARE_STYLE_HASH}; img-src 'self' data:; ` +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'private, no-store',
});

/** A whole page: the shell around `main`, with `head` before the stylesheet. */
export function page(title: string, main: string, head = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${head}<style>${SHARE_STYLE}</style>
</head>
<body>
<main>
${main}</main>
<footer>Shared from Mossgoblin</footer>
</body>
</html>
`;
}

/** The one page for a share that is not there, stopped, not shown here, or never was. */
export const NOT_FOUND_PAGE = page(
  'Not found',
  '<h1>Nothing here</h1>\n<p>This link does not lead to anything shared. It may have been ' +
    'stopped, or mistyped.</p>\n',
);

/** The page for a moment the shares cannot be read. */
export const UNAVAILABLE_PAGE = page(
  'Try again',
  '<h1>Not now</h1>\n<p>This could not be loaded just now. Try again in a minute.</p>\n',
);
