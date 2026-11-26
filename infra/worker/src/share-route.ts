// `/s/<shareId>`, a note's public page (2026-11-26; DESIGN.md, Sharing a
// public copy). Rendered by the `publicShare` function, not here: a
// note's markdown can take more CPU than a Worker request is allowed.
// The Worker does the cheap part. It answers anything but GET or HEAD
// with 405 and a malformed id with the one 404 itself, forwards the
// rest, and puts the page's own headers on whatever comes back: the
// page, or the same 404 bytes, or a 503 to try again, never anything
// else the function's host might say.
import {
  NOT_FOUND_PAGE,
  SHARE_HEADERS,
  UNAVAILABLE_PAGE,
  shareIdOf,
} from '../../../packages/schema/src/share-shell';

export { isSharePath } from '../../../packages/schema/src/share-shell';

/**
 * Answers `request` on `/s/...`; `forward` sends it on to the function
 * (undefined when FUNCTIONS_ORIGIN is not set).
 */
export async function serveShare(
  request: Request,
  forward: ((request: Request) => Promise<Response>) | undefined,
): Promise<Response> {
  const head = request.method === 'HEAD';
  const answer = (status: number, html: string | null, more: Record<string, string> = {}) =>
    new Response(head ? null : html, { status, headers: { ...SHARE_HEADERS, ...more } });
  if (request.method !== 'GET' && !head) return answer(405, 'GET only', { allow: 'GET, HEAD' });
  if (!shareIdOf(new URL(request.url).pathname)) return answer(404, NOT_FOUND_PAGE);
  if (!forward) return answer(503, UNAVAILABLE_PAGE, { 'retry-after': '60' });
  let upstream: Response;
  try {
    // Nothing of the reader's goes on: no cookie, no credentials.
    upstream = await forward(new Request(request.url, { method: request.method }));
  } catch {
    return answer(503, UNAVAILABLE_PAGE, { 'retry-after': '60' });
  }
  if (upstream.status === 200) {
    return new Response(head ? null : upstream.body, { status: 200, headers: SHARE_HEADERS });
  }
  await upstream.body?.cancel();
  if (upstream.status === 404) return answer(404, NOT_FOUND_PAGE);
  return answer(503, UNAVAILABLE_PAGE, { 'retry-after': '60' });
}
