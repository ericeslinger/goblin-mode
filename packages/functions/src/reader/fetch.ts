// The production feed fetcher (#161): a public request with the
// conditional headers, the feed size cap, and the body as text in the
// charset the site declared.
import { publicRequest } from '../attachments/import';
import { FEED_MAX_BYTES, type FeedFetcher } from './refresh';

/** The body decoded by the content type's charset, UTF-8 when none or unknown. */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

export const feedFetch: FeedFetcher = async (url, seen) => {
  const res = await publicRequest(url, {
    maxBytes: FEED_MAX_BYTES,
    userAgent: 'Mossgoblin/1 (feed reader)',
    headers: {
      accept:
        'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9, */*;q=0.5',
      ...(seen.etag ? { 'if-none-match': seen.etag } : {}),
      ...(seen.lastModified ? { 'if-modified-since': seen.lastModified } : {}),
    },
  });
  return {
    status: res.status,
    contentType: res.contentType,
    text: res.status === 304 ? '' : decodeBody(res.bytes, res.contentType),
    ...(res.header('etag') ? { etag: res.header('etag') } : {}),
    ...(res.header('last-modified') ? { lastModified: res.header('last-modified') } : {}),
  };
};
