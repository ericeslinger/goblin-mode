// Reader mode (#163): the article out of a whole page. Not a browser
// and not Readability: hidden elements go first (visibleHtml), then the
// page's navigation, headers, footers and asides, and the largest of
// the blocks a page marks as its article is kept, or the body when none
// is marked or holds a fair share of the words. Then the same markdown
// as a feed's content, with a longer cap.
import { visibleHtml } from '../attachments/import';
import { htmlToMarkdown } from './markdown';

/** The most of a page's article kept, in characters. */
export const READER_MAX = 100_000;

/** Elements that frame an article but are never it. */
const BOILERPLATE =
  /<(nav|header|footer|aside|form|script|style|noscript|iframe|template|dialog|menu)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/** Where pages mark their article, most specific first. */
const MARKED = [
  /<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi,
  /<[a-z][a-z0-9-]*\b[^>]*\brole=["']main["'][^>]*>([\s\S]*?)<\/[a-z][a-z0-9-]*\s*>/gi,
  /<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi,
  /<[a-z][a-z0-9-]*\b[^>]*\b(?:id|class)=["'][^"']*(?:post-content|entry-content|article-body|post-body|content-body|story-body|article__body|e-content|articleBody)[^"']*["'][^>]*>([\s\S]*?)<\/[a-z][a-z0-9-]*\s*>/gi,
];

const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;

/** The HTML of the page's article, best effort. */
export function mainContent(html: string): string {
  const visible = visibleHtml(html).replace(BOILERPLATE, ' ');
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(visible)?.[1] ?? visible;
  const candidates: string[] = [];
  for (const re of MARKED) for (const m of body.matchAll(re)) candidates.push(m[1]);
  const best = candidates.sort((a, b) => words(b) - words(a))[0];
  // A marked block that holds a fair share of the page is the article;
  // a tiny one (a teaser, a comment) is not, and the body stands.
  return best && words(best) >= Math.min(1000, words(body) * 0.3) ? best : body;
}

/** The page's article as markdown, resolved against `url`. */
export function readerMarkdown(html: string, url: string): string {
  return htmlToMarkdown(mainContent(html), url, READER_MAX);
}
